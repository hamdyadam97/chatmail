"""Announcements: audience resolution + publish permission, no hidden
recipients, signed acknowledgements, compliance/reminders, privacy gates,
and the one-welcome-many-devices delivery used for large groups."""
import base64
import os
import uuid
from datetime import timedelta

import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.announcements.models import Announcement, AnnouncementRecipient
from apps.messaging.models import Message, WelcomeRecipient
from apps.notifications.models import Notification

from .approvals_utils import canonical, signing_device
from .conftest import assign_role
from .correspondence_utils import b64, json_text_payload, make_employee
from .messaging_utils import CONV_URL, auth, commit, make_device, mls_payload, post_message

pytestmark = pytest.mark.django_db

ANN_URL = "/api/v1/announcements/"
ACK_CONTEXT = b"announcement-ack-v1\n"


@pytest.fixture
def org(api_client, user_factory, branch_a, branch_a2, branch_b, department_a):
    pub = make_employee(user_factory, "a_pub", branch_a)
    assign_role(pub, "branch_manager", institute=branch_a.institute, branch=branch_a)
    e1 = make_employee(user_factory, "a_e1", branch_a)
    e2 = make_employee(user_factory, "a_e2", branch_a)
    e3 = make_employee(user_factory, "a_e3", department_a)  # department inside branch_a
    other = make_employee(user_factory, "a_other", branch_a2)
    foreign = make_employee(user_factory, "a_foreign", branch_b)
    return {
        "pub": pub, "e1": e1, "e2": e2, "e3": e3, "other": other, "foreign": foreign,
        "branch_a": branch_a, "branch_a2": branch_a2, "department_a": department_a,
        "h_pub": auth(api_client, "a_pub"), "h_e1": auth(api_client, "a_e1"),
        "h_e2": auth(api_client, "a_e2"), "h_other": auth(api_client, "a_other"),
        "d_pub": make_device(pub).id,
    }


def prepare(client, headers, target_type, target_id=None, user_ids=(), **extra):
    body = {
        "target_type": target_type,
        "target_id": str(target_id) if target_id else None,
        "user_ids": [str(u) for u in user_ids],
        "mls_group_id": b64(os.urandom(16)),
        "client_ref": str(uuid.uuid4()),
        **extra,
    }
    return client.post(ANN_URL, body, format="json", **headers)


def publish(client, headers, ann, device_id, payload=None):
    commit(client, headers, ann["thread"]["id"], device_id, epoch=1)
    return client.post(f"{ANN_URL}{ann['id']}/publish/", {
        "mls_payload": b64(payload if payload is not None else mls_payload()),
        "client_msg_id": str(uuid.uuid4()),
        "epoch": 1,
        "sender_device_id": str(device_id),
    }, format="json", **headers)


def published(client, org, **extra):
    ann = prepare(client, org["h_pub"], "branch", org["branch_a"].id, **extra).json()
    resp = publish(client, org["h_pub"], ann, org["d_pub"])
    assert resp.status_code == 200, resp.content
    return resp.json()


def ack_body(ann, user, signer, **override):
    device, priv = signer
    payload = {
        "acknowledged_at": timezone.now().isoformat(),
        "announcement_id": ann["id"],
        "content_hash": ann["content_hash"],
        "device_id": str(device.id),
        "user_id": str(user.id),
    }
    payload.update(override)
    raw = canonical(payload)
    return {
        "payload": base64.b64encode(raw).decode(),
        "signature": base64.b64encode(priv.sign(ACK_CONTEXT + raw)).decode(),
        "device_id": str(device.id),
    }


# --- audience + permission ---------------------------------------------------------

def test_branch_audience_includes_department_members_and_excludes_publisher(api_client, org):
    resp = prepare(api_client, org["h_pub"], "branch", org["branch_a"].id)
    assert resp.status_code == 201, resp.content
    ann = Announcement.objects.get(id=resp.json()["id"])
    users = set(ann.recipients.values_list("user__username", flat=True))
    assert users == {"a_e1", "a_e2", "a_e3"}
    assert ann.thread.type == "announcement"
    assert ann.thread.active_members().count() == 4  # + publisher


@pytest.mark.parametrize("case", ["no-role", "other-branch", "all-needs-central", "foreign-user"])
def test_publish_permission_is_scoped(api_client, org, case):
    if case == "no-role":
        resp = prepare(api_client, org["h_e1"], "branch", org["branch_a"].id)
    elif case == "other-branch":
        resp = prepare(api_client, org["h_pub"], "branch", org["branch_a2"].id)
    elif case == "all-needs-central":
        resp = prepare(api_client, org["h_pub"], "all")
    else:
        resp = prepare(api_client, org["h_pub"], "users", user_ids=[org["e1"].id, org["foreign"].id])
    assert resp.status_code == 403, resp.content


def test_central_executive_publishes_to_all_institutes(api_client, user_factory, org):
    exe = make_employee(user_factory, "a_exe", org["branch_a"])
    assign_role(exe, "executive")  # central
    resp = prepare(api_client, auth(api_client, "a_exe"), "all")
    assert resp.status_code == 201, resp.content
    users = set(Announcement.objects.get(id=resp.json()["id"]).recipients.values_list("user__username", flat=True))
    assert {"a_e1", "a_other", "a_foreign"} <= users


def test_named_users_and_department_targets(api_client, org):
    resp = prepare(api_client, org["h_pub"], "users", user_ids=[org["e1"].id])
    assert resp.status_code == 201
    dept = prepare(api_client, org["h_pub"], "department", org["department_a"].id).json()
    assert set(Announcement.objects.get(id=dept["id"]).recipients.values_list("user__username", flat=True)) == {"a_e3"}


def test_audience_cap(api_client, org, settings):
    settings.ANNOUNCEMENT_MAX_RECIPIENTS = 2
    assert prepare(api_client, org["h_pub"], "branch", org["branch_a"].id).status_code == 400


# --- publish ---------------------------------------------------------------------------

def test_draft_hidden_then_published_with_reference(api_client, org):
    ann = prepare(api_client, org["h_pub"], "branch", org["branch_a"].id).json()
    assert api_client.get(f"{ANN_URL}{ann['id']}/", **org["h_e1"]).status_code == 403
    # content only through /publish/, and membership is fixed
    assert post_message(api_client, org["h_pub"], ann["thread"]["id"], "application", mls_payload(),
                        sender_device_id=org["d_pub"]).status_code == 403
    assert api_client.post(f"{CONV_URL}{ann['thread']['id']}/members/", {"user_ids": [str(org["other"].id)]},
                           format="json", **org["h_pub"]).status_code == 403
    resp = publish(api_client, org["h_pub"], ann, org["d_pub"])
    assert resp.status_code == 200, resp.content
    data = resp.json()
    assert data["reference_number"] == f"AHL-TAM-{timezone.localtime().year}-00001"
    assert data["status"] == "published" and data["content_hash"]
    assert Notification.objects.filter(kind="announcement", ref_id=ann["id"]).count() == 3


def test_publish_rejects_plaintext(api_client, org):
    ann = prepare(api_client, org["h_pub"], "branch", org["branch_a"].id).json()
    assert publish(api_client, org["h_pub"], ann, org["d_pub"], payload=json_text_payload()).status_code == 400


# --- recipients: receipt, read, signed ack -----------------------------------------------

def test_receipt_read_and_signed_ack(api_client, org):
    ann = published(api_client, org)
    detail = api_client.get(f"{ANN_URL}{ann['id']}/", **org["h_e1"]).json()
    assert detail["mine"]["delivered_at"] is not None and detail["mine"]["read_at"] is None
    assert api_client.post(f"{ANN_URL}{ann['id']}/read/", **org["h_e1"]).status_code == 204

    signer = signing_device(org["e1"])
    url = f"{ANN_URL}{ann['id']}/ack/"
    other_version = ack_body(ann, org["e1"], signer, content_hash=base64.b64encode(b"x" * 32).decode())
    assert api_client.post(url, other_version, format="json", **org["h_e1"]).status_code == 400
    foreign_device = signing_device(org["e2"])
    assert api_client.post(url, ack_body(ann, org["e1"], foreign_device), format="json",
                           **org["h_e1"]).status_code == 403
    ok = api_client.post(url, ack_body(ann, org["e1"], signer), format="json", **org["h_e1"])
    assert ok.status_code == 200, ok.content
    row = AnnouncementRecipient.objects.get(announcement_id=ann["id"], user=org["e1"])
    assert row.acknowledged_at and row.ack_signature and row.ack_device_id == signer[0].id
    # idempotent
    assert api_client.post(url, ack_body(ann, org["e1"], signer), format="json", **org["h_e1"]).status_code == 200


def test_pending_ack_box(api_client, org):
    ann = published(api_client, org)
    box = api_client.get(f"{ANN_URL}?box=received&pending_ack=1", **org["h_e2"]).json()
    assert [i["id"] for i in box["results"]] == [ann["id"]]


# --- privacy -------------------------------------------------------------------------------

@pytest.mark.parametrize("who", ["other-branch-manager", "sys_admin"])
def test_non_recipients_cannot_open(api_client, user_factory, org, who):
    ann = published(api_client, org)
    boss = make_employee(user_factory, "a_boss", org["branch_a2"])
    if who == "sys_admin":
        assign_role(boss, "sys_admin")
    else:
        assign_role(boss, "branch_manager", branch=org["branch_a2"])
    h = auth(api_client, "a_boss")
    for path in ("", "audience/", "compliance/"):
        assert api_client.get(f"{ANN_URL}{ann['id']}/{path}", **h).status_code == 403
    assert api_client.get(f"{CONV_URL}{ann['thread']['id']}/messages/", **h).status_code == 403


def test_audience_is_disclosed_to_recipients(api_client, org):
    ann = published(api_client, org)
    aud = api_client.get(f"{ANN_URL}{ann['id']}/audience/", **org["h_e2"]).json()
    assert {u["username"] for u in aud["recipients"]} == {"a_e1", "a_e2", "a_e3"}
    assert aud["publisher"]["username"] == "a_pub"


# --- compliance + reminders --------------------------------------------------------------------

def test_compliance_visible_to_publisher_and_trackers_only(api_client, user_factory, org):
    ann = published(api_client, org)
    api_client.get(f"{ANN_URL}{ann['id']}/", **org["h_e1"])  # delivered
    rep = api_client.get(f"{ANN_URL}{ann['id']}/compliance/", **org["h_pub"]).json()
    assert (rep["total"], rep["delivered"], rep["acknowledged"]) == (3, 1, 0)
    assert api_client.get(f"{ANN_URL}{ann['id']}/compliance/", **org["h_e1"]).status_code == 403
    head = make_employee(user_factory, "a_head", org["branch_a"])
    assign_role(head, "dept_head", branch=org["branch_a"])  # holds announcements.track_ack
    h_head = auth(api_client, "a_head")
    assert api_client.get(f"{ANN_URL}{ann['id']}/compliance/", **h_head).status_code == 200
    # tracking metadata never opens content
    assert api_client.get(f"{ANN_URL}{ann['id']}/", **h_head).status_code == 403


def test_manual_reminder_targets_unacknowledged_with_cooldown(api_client, org):
    ann = published(api_client, org)
    api_client.post(f"{ANN_URL}{ann['id']}/ack/", ack_body(ann, org["e1"], signing_device(org["e1"])),
                    format="json", **org["h_e1"])
    resp = api_client.post(f"{ANN_URL}{ann['id']}/remind/", **org["h_pub"])
    assert resp.json() == {"reminded": 2}
    reminded = set(Notification.objects.filter(kind="announcement_reminder").values_list("user__username", flat=True))
    assert reminded == {"a_e2", "a_e3"}
    assert api_client.post(f"{ANN_URL}{ann['id']}/remind/", **org["h_pub"]).status_code == 409


def test_scheduled_reminders_near_deadline(api_client, org):
    due = (timezone.now() + timedelta(hours=6)).isoformat()
    published(api_client, org, ack_due_at=due)
    call_command("send_announcement_reminders")
    assert Notification.objects.filter(kind="announcement_reminder").count() == 3
    call_command("send_announcement_reminders")  # once per 24 h
    assert Notification.objects.filter(kind="announcement_reminder").count() == 3


def test_withdraw_blocks_new_acks(api_client, org):
    ann = published(api_client, org)
    assert api_client.post(f"{ANN_URL}{ann['id']}/withdraw/", **org["h_e1"]).status_code == 403
    assert api_client.post(f"{ANN_URL}{ann['id']}/withdraw/", **org["h_pub"]).json()["status"] == "withdrawn"
    resp = api_client.post(f"{ANN_URL}{ann['id']}/ack/", ack_body(ann, org["e1"], signing_device(org["e1"])),
                           format="json", **org["h_e1"])
    assert resp.status_code == 409


# --- one welcome, many devices ---------------------------------------------------------------------

def test_single_welcome_addressed_to_many_devices(api_client, org):
    ann = prepare(api_client, org["h_pub"], "branch", org["branch_a"].id).json()
    devices = [make_device(org[k]) for k in ("e1", "e2", "e3")]
    resp = post_message(api_client, org["h_pub"], ann["thread"]["id"], "welcome", mls_payload(), epoch=0)
    assert resp.status_code == 400  # needs recipients
    body = {
        "kind": "welcome",
        "mls_payload": b64(mls_payload(2048)),
        "client_msg_id": str(uuid.uuid4()),
        "epoch": 0,
        "recipient_device_ids": [str(d.id) for d in devices],
    }
    resp = api_client.post(f"{CONV_URL}{ann['thread']['id']}/messages/", body, format="json", **org["h_pub"])
    assert resp.status_code == 201, resp.content
    assert Message.objects.filter(kind="welcome").count() == 1
    assert WelcomeRecipient.objects.count() == 3
    rows = api_client.get(f"{CONV_URL}{ann['thread']['id']}/messages/", **org["h_e2"]).json()["messages"]
    assert [m["kind"] for m in rows] == ["welcome"]
    # a member who is not addressed does not see it
    own = api_client.get(f"{CONV_URL}{ann['thread']['id']}/messages/", **org["h_pub"]).json()["messages"]
    assert own == []
    # a device of a non-member cannot be addressed
    body["client_msg_id"] = str(uuid.uuid4())
    body["recipient_device_ids"] = [str(make_device(org["other"]).id)]
    assert api_client.post(f"{CONV_URL}{ann['thread']['id']}/messages/", body, format="json",
                           **org["h_pub"]).status_code == 400
