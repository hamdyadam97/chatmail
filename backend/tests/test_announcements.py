"""Announcements: audience resolution + publish permission, sealed content,
acknowledgements, compliance/reminders, withdrawal and privacy gates."""
import uuid
from datetime import timedelta

import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.announcements.models import Announcement, AnnouncementRecipient
from apps.messaging.models import Message
from apps.notifications.models import Notification

from .conftest import assign_role
from .correspondence_utils import make_employee
from .messaging_utils import CONV_URL, auth, post_message

pytestmark = pytest.mark.django_db

ANN_URL = "/api/v1/announcements/"


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
    }


def prepare(client, headers, target_type, target_id=None, user_ids=(), **extra):
    """Publish (one call): audience + sealed {title, body}."""
    body = {
        "target_type": target_type,
        "target_id": str(target_id) if target_id else None,
        "user_ids": [str(u) for u in user_ids],
        "client_ref": str(uuid.uuid4()),
        "title": "تعميم الدوام",
        "body": "يبدأ الدوام الساعة الثامنة",
        **extra,
    }
    return client.post(ANN_URL, body, format="json", **headers)


def published(client, org, **extra):
    resp = prepare(client, org["h_pub"], "branch", org["branch_a"].id, **extra)
    assert resp.status_code == 201, resp.content
    return resp.json()


def ack(client, headers, ann):
    return client.post(f"{ANN_URL}{ann['id']}/ack/", **headers)


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

def test_published_with_reference_sealed_and_notified(api_client, org):
    ann = published(api_client, org)
    assert ann["reference_number"] == f"AHL-TAM-{timezone.localtime().year}-00001"
    assert ann["status"] == "published" and ann["content_hash"]
    assert ann["content"] == {"title": "تعميم الدوام", "body": "يبدأ الدوام الساعة الثامنة"}
    stored = bytes(Message.objects.get(conversation_id=Announcement.objects.get(id=ann["id"]).thread_id).content_enc)
    assert "الدوام".encode() not in stored
    assert Notification.objects.filter(kind="announcement", ref_id=ann["id"]).count() == 3
    seen = api_client.get(f"{ANN_URL}{ann['id']}/", **org["h_e1"]).json()
    assert seen["content"]["title"] == "تعميم الدوام"


def test_title_required_and_thread_closed_to_chat(api_client, org):
    assert prepare(api_client, org["h_pub"], "branch", org["branch_a"].id, title="").status_code == 400
    ann = published(api_client, org)
    thread_id = str(Announcement.objects.get(id=ann["id"]).thread_id)
    assert post_message(api_client, org["h_pub"], thread_id, "خارج المسار").status_code == 403
    assert api_client.post(f"{CONV_URL}{thread_id}/members/", {"user_ids": [str(org["other"].id)]},
                           format="json", **org["h_pub"]).status_code == 403


# --- recipients: receipt, read, ack -----------------------------------------------------

def test_receipt_read_and_ack(api_client, org):
    ann = published(api_client, org)
    detail = api_client.get(f"{ANN_URL}{ann['id']}/", **org["h_e1"]).json()
    assert detail["mine"]["delivered_at"] is not None and detail["mine"]["read_at"] is None
    assert api_client.post(f"{ANN_URL}{ann['id']}/read/", **org["h_e1"]).status_code == 204
    ok = ack(api_client, org["h_e1"], ann)
    assert ok.status_code == 200, ok.content
    row = AnnouncementRecipient.objects.get(announcement_id=ann["id"], user=org["e1"])
    assert row.acknowledged_at and bytes(row.ack_content_hash) == bytes(
        Announcement.objects.get(id=ann["id"]).content_hash)
    assert ack(api_client, org["h_e1"], ann).status_code == 200  # idempotent
    assert ack(api_client, org["h_other"], ann).status_code == 403


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
    thread_id = Announcement.objects.get(id=ann["id"]).thread_id
    assert api_client.get(f"{CONV_URL}{thread_id}/messages/", **h).status_code == 403


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
    ack(api_client, org["h_e1"], ann)
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


def test_withdraw_hides_content_and_blocks_new_acks(api_client, org):
    ann = published(api_client, org)
    assert api_client.post(f"{ANN_URL}{ann['id']}/withdraw/", **org["h_e1"]).status_code == 403
    assert api_client.post(f"{ANN_URL}{ann['id']}/withdraw/", **org["h_pub"]).json()["status"] == "withdrawn"
    assert ack(api_client, org["h_e1"], ann).status_code == 409
    assert api_client.get(f"{ANN_URL}{ann['id']}/", **org["h_e1"]).json()["content"] is None
    assert api_client.get(f"{ANN_URL}{ann['id']}/", **org["h_pub"]).json()["content"]["title"] == "تعميم الدوام"
