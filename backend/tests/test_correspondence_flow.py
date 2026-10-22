"""Correspondence lifecycle: prepare → MLS setup → send (frozen), replies,
forwards, folders, reference numbers and immutability.

Payloads are opaque binary stand-ins; the real MLS round trip is proven by
frontend/scripts/e2e-correspondence.mjs.
"""
import uuid

import pytest
from django.utils import timezone

from apps.audit.models import AuditLog
from apps.correspondence.models import (
    Correspondence,
    CorrespondenceEvent,
    ImmutableCorrespondenceError,
)
from apps.messaging.models import Conversation

from .conftest import make_user
from .correspondence_utils import (  # noqa: F401  (fixtures)
    CONV_URL,
    CORR_URL,
    _blob_root,
    b64,
    commit,
    json_text_payload,
    make_employee,
    mls_payload,
    office,
    prepare,
    prepare_and_send,
    reply,
    send,
    setup_thread,
)
from .messaging_utils import post_message

pytestmark = pytest.mark.django_db


def _ids(page):
    return [item["id"] for item in page.json()["results"]]


# --- prepare --------------------------------------------------------------------

def test_prepare_creates_hidden_thread_and_sender_only_draft(api_client, office):
    resp = prepare(api_client, office["h_s"], [office["r1"]], [office["r2"]])
    assert resp.status_code == 201, resp.content
    data = resp.json()
    assert data["status"] == "draft"
    assert data["reference_number"] is None
    assert data["content"] is None

    thread = Conversation.objects.get(id=data["thread"]["id"])
    assert thread.type == "correspondence"
    assert {str(u) for u in thread.active_members().values_list("user_id", flat=True)} == {
        str(office["s"].id), str(office["r1"].id), str(office["r2"].id)
    }
    # the thread is not a chat
    listed = api_client.get(CONV_URL, **office["h_s"]).json()
    assert data["thread"]["id"] not in [c["id"] for c in listed]
    # recipients cannot see an unsent draft
    assert api_client.get(f"{CORR_URL}{data['id']}/", **office["h_r1"]).status_code == 403
    assert data["id"] not in _ids(api_client.get(f"{CORR_URL}?folder=inbox", **office["h_r1"]))
    assert data["id"] in _ids(api_client.get(f"{CORR_URL}?folder=drafts", **office["h_s"]))


def test_prepare_is_idempotent_on_client_ref(api_client, office):
    ref = str(uuid.uuid4())
    first = prepare(api_client, office["h_s"], [office["r1"]], client_ref=ref)
    second = prepare(api_client, office["h_s"], [office["r1"]], client_ref=ref)
    assert first.status_code == 201 and second.status_code == 200
    assert first.json()["id"] == second.json()["id"]


@pytest.mark.parametrize(
    "case",
    ["self", "duplicate", "inactive", "empty_to"],
)
def test_prepare_rejects_bad_recipients(api_client, office, user_factory, case):
    s, r1 = office["s"], office["r1"]
    if case == "self":
        resp = prepare(api_client, office["h_s"], [s])
    elif case == "duplicate":
        resp = prepare(api_client, office["h_s"], [r1], [r1])
    elif case == "inactive":
        resp = prepare(api_client, office["h_s"], [user_factory("c_gone", is_active=False)])
    else:
        resp = prepare(api_client, office["h_s"], [])
    assert resp.status_code == 400, resp.content


def test_bcc_is_disabled_by_default(api_client, office):
    resp = prepare(api_client, office["h_s"], [office["r1"]], bcc_user_ids=[str(office["r2"].id)])
    assert resp.status_code == 400
    assert "bcc_user_ids" in resp.json()


def test_send_requires_correspondence_send_permission(api_client, user_factory, branch_a, office):
    make_user("c_norole", membership_unit=branch_a)  # member, but no role assignment
    from .messaging_utils import auth

    h = auth(api_client, "c_norole")
    assert prepare(api_client, h, [office["r1"]]).status_code == 403


def test_send_requires_an_org_membership(api_client, user_factory, office):
    make_user("c_nomember")
    from .messaging_utils import auth

    h = auth(api_client, "c_nomember")
    resp = prepare(api_client, h, [office["r1"]])
    assert resp.status_code == 400
    assert "sender_membership_id" in resp.json()


# --- send -----------------------------------------------------------------------------

def test_full_send_flow_assigns_reference_and_delivers(api_client, office):
    sent = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]], [office["r2"]])
    year = timezone.localtime().year
    assert sent["status"] == "sent"
    assert sent["reference_number"] == f"AHL-RYD-{year}-000001"
    assert sent["content"]["seq"] >= 1

    inbox = api_client.get(f"{CORR_URL}?folder=inbox", **office["h_r1"])
    assert sent["id"] in _ids(inbox)
    item = inbox.json()["results"][0]
    assert item["my_kind"] == "to" and item["read_at"] is None
    assert sent["id"] in _ids(api_client.get(f"{CORR_URL}?folder=inbox", **office["h_r2"]))
    assert sent["id"] in _ids(api_client.get(f"{CORR_URL}?folder=sent", **office["h_s"]))

    detail = api_client.get(f"{CORR_URL}{sent['id']}/", **office["h_r1"]).json()
    assert detail["content"]["mls_payload"] == sent["content"]["mls_payload"]
    assert detail["thread"]["mls_group_id"]
    # the recipient can fetch the thread's MLS stream to decrypt it
    assert api_client.get(f"{CONV_URL}{sent['thread_id']}/messages/", **office["h_r1"]).status_code == 200

    assert api_client.post(f"{CORR_URL}{sent['id']}/read/", **office["h_r1"]).status_code == 204
    detail = api_client.get(f"{CORR_URL}{sent['id']}/", **office["h_r1"]).json()
    assert detail["read_at"] is not None
    events = [e["event_type"] for e in api_client.get(
        f"{CORR_URL}{sent['id']}/events/", **office["h_s"]).json()]
    assert events == ["created", "sent", "read"]
    assert AuditLog.objects.filter(action="correspondence_sent", target_id=str(sent["id"])).exists()


def test_send_before_mls_setup_is_an_epoch_conflict(api_client, office):
    data = prepare(api_client, office["h_s"], [office["r1"]]).json()
    resp = send(api_client, office["h_s"], data["id"], office["d_s"])
    assert resp.status_code == 409


def test_send_rejects_plaintext_content(api_client, office):
    data = prepare(api_client, office["h_s"], [office["r1"]]).json()
    setup_thread(api_client, office["h_s"], data["thread"]["id"], office["d_s"])
    resp = send(api_client, office["h_s"], data["id"], office["d_s"], payload=json_text_payload())
    assert resp.status_code == 400
    assert Correspondence.objects.get(id=data["id"]).status == "draft"


def test_send_is_idempotent_and_then_immutable(api_client, office):
    data = prepare(api_client, office["h_s"], [office["r1"]]).json()
    setup_thread(api_client, office["h_s"], data["thread"]["id"], office["d_s"])
    msg_id = uuid.uuid4()
    first = send(api_client, office["h_s"], data["id"], office["d_s"], client_msg_id=msg_id)
    again = send(api_client, office["h_s"], data["id"], office["d_s"], client_msg_id=msg_id)
    assert first.status_code == again.status_code == 200
    assert first.json()["reference_number"] == again.json()["reference_number"]
    other = send(api_client, office["h_s"], data["id"], office["d_s"])
    assert other.status_code == 409


def test_only_sender_can_send(api_client, office):
    data = prepare(api_client, office["h_s"], [office["r1"]]).json()
    setup_thread(api_client, office["h_s"], data["thread"]["id"], office["d_s"])
    # recipient cannot even see the draft, let alone send it
    assert send(api_client, office["h_r1"], data["id"], office["d_r1"]).status_code == 403


def test_sent_correspondence_is_immutable(api_client, office):
    sent = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]])
    url = f"{CORR_URL}{sent['id']}/"
    assert api_client.patch(url, {"priority": "low"}, format="json", **office["h_s"]).status_code == 405
    assert api_client.put(url, {"priority": "low"}, format="json", **office["h_s"]).status_code == 405
    assert api_client.delete(url, **office["h_s"]).status_code == 409

    obj = Correspondence.objects.get(id=sent["id"])
    obj.priority = "low"
    with pytest.raises(ImmutableCorrespondenceError):
        obj.save()
    obj = Correspondence.objects.get(id=sent["id"])
    obj.status = "draft"
    with pytest.raises(ImmutableCorrespondenceError):
        obj.save()
    with pytest.raises(ImmutableCorrespondenceError):
        Correspondence.objects.get(id=sent["id"]).delete()


def test_thread_content_only_enters_through_send(api_client, office):
    data = prepare(api_client, office["h_s"], [office["r1"]]).json()
    thread_id = data["thread"]["id"]
    setup_thread(api_client, office["h_s"], thread_id, office["d_s"])
    resp = post_message(api_client, office["h_s"], thread_id, "application", mls_payload(),
                        sender_device_id=office["d_s"])
    assert resp.status_code == 403


def test_thread_membership_cannot_be_widened(api_client, office):
    data = prepare(api_client, office["h_s"], [office["r1"]]).json()
    thread_id = data["thread"]["id"]
    outsider = str(office["o"].id)
    assert api_client.post(f"{CONV_URL}{thread_id}/members/", {"user_ids": [outsider]},
                           format="json", **office["h_s"]).status_code == 403
    assert api_client.post(f"{CONV_URL}{thread_id}/members/remove/",
                           {"user_ids": [str(office["r1"].id)]},
                           format="json", **office["h_s"]).status_code == 403
    sneaky = commit(api_client, office["h_s"], thread_id, office["d_s"], epoch=1,
                    membership={"added_user_ids": [outsider], "removed_user_ids": []})
    assert sneaky.status_code == 403
    # the creation commit naming the existing recipients is fine
    ok = commit(api_client, office["h_s"], thread_id, office["d_s"], epoch=1,
                membership={"added_user_ids": [str(office["r1"].id)], "removed_user_ids": []})
    assert ok.status_code == 201


def test_discard_draft_removes_thread(api_client, office):
    data = prepare(api_client, office["h_s"], [office["r1"]]).json()
    assert api_client.delete(f"{CORR_URL}{data['id']}/", **office["h_r1"]).status_code == 403
    assert api_client.delete(f"{CORR_URL}{data['id']}/", **office["h_s"]).status_code == 204
    assert not Correspondence.objects.filter(id=data["id"]).exists()
    assert not Conversation.objects.filter(id=data["thread"]["id"]).exists()


# --- reference numbers -----------------------------------------------------------

def test_reference_numbers_are_sequential_per_institute(api_client, office, user_factory, branch_b):
    year = timezone.localtime().year
    refs = [
        prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]])["reference_number"]
        for _ in range(3)
    ]
    assert refs == [f"AHL-RYD-{year}-00000{i}" for i in (1, 2, 3)]

    # another institute has its own counter
    from .messaging_utils import auth, make_device

    other = make_employee(user_factory, "c_faw", branch_b)
    h = auth(api_client, "c_faw")
    ref = prepare_and_send(api_client, h, make_device(other).id, [office["r1"]])["reference_number"]
    assert ref == f"FAW-FAW-B1-{year}-000001"
    assert Correspondence.objects.filter(reference_number__isnull=False).values(
        "reference_number").distinct().count() == 4


def test_reference_without_branch_uses_institute_only(api_client, user_factory, institute_a, office):
    from .conftest import assign_role
    from .messaging_utils import auth, make_device

    hq = user_factory("c_hq", membership_unit=institute_a)
    assign_role(hq, "employee", institute=institute_a)
    ref = prepare_and_send(api_client, auth(api_client, "c_hq"), make_device(hq).id,
                           [office["r1"]])["reference_number"]
    assert ref == f"AHL-{timezone.localtime().year}-000001"


# --- replies -----------------------------------------------------------------------

def test_reply_stays_in_thread_and_addresses_original_sender(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]], [office["r2"]])
    pending = api_client.get(f"{CORR_URL}?folder=pending_replies", **office["h_r1"])
    assert root["id"] in _ids(pending)

    resp = reply(api_client, office["h_r1"], root["id"], office["d_r1"])
    assert resp.status_code == 201, resp.content
    rep = resp.json()
    assert rep["thread_id"] == root["thread_id"]
    assert rep["thread_root_id"] == root["id"] and rep["reply_to_id"] == root["id"]
    assert rep["reference_number"] and rep["reference_number"] != root["reference_number"]
    kinds = {p["user"]["id"]: p["kind"] for p in rep["participants"]}
    assert kinds == {str(office["s"].id): "to", str(office["r2"].id): "cc"}

    assert rep["id"] in _ids(api_client.get(f"{CORR_URL}?folder=inbox", **office["h_s"]))
    assert root["id"] not in _ids(api_client.get(f"{CORR_URL}?folder=pending_replies", **office["h_r1"]))
    assert CorrespondenceEvent.objects.filter(correspondence_id=root["id"], event_type="replied").exists()

    detail = api_client.get(f"{CORR_URL}{root['id']}/", **office["h_r2"]).json()
    assert [i["id"] for i in detail["thread_items"]] == [root["id"], rep["id"]]


def test_outsider_cannot_reply(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]])
    assert reply(api_client, office["h_o"], root["id"], office["d_o"]).status_code == 403


def test_reply_to_closed_correspondence_is_refused(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]])
    assert api_client.post(f"{CORR_URL}{root['id']}/close/", **office["h_r1"]).status_code == 403
    assert api_client.post(f"{CORR_URL}{root['id']}/close/", **office["h_s"]).status_code == 200
    assert reply(api_client, office["h_r1"], root["id"], office["d_r1"]).status_code == 400


# --- forwards --------------------------------------------------------------------------

def test_forward_opens_new_thread_without_source_access(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]])
    body = {
        "to_user_ids": [str(office["o"].id)],
        "mls_group_id": b64(__import__("os").urandom(16)),
        "client_ref": str(uuid.uuid4()),
    }
    resp = api_client.post(f"{CORR_URL}{root['id']}/forward/", body, format="json", **office["h_r1"])
    assert resp.status_code == 201, resp.content
    fwd = resp.json()
    assert fwd["thread_id"] != root["thread_id"]
    assert fwd["is_forward"] is True
    assert fwd["forwarded_from_reference"] == root["reference_number"]

    setup_thread(api_client, office["h_r1"], fwd["thread"]["id"], office["d_r1"])
    sent = send(api_client, office["h_r1"], fwd["id"], office["d_r1"])
    assert sent.status_code == 200

    # the new recipient reads the forward, but never the source or its thread
    assert api_client.get(f"{CORR_URL}{fwd['id']}/", **office["h_o"]).status_code == 200
    assert api_client.get(f"{CORR_URL}{root['id']}/", **office["h_o"]).status_code == 403
    assert api_client.get(f"{CONV_URL}{root['thread_id']}/messages/", **office["h_o"]).status_code == 403
    assert CorrespondenceEvent.objects.filter(correspondence_id=root["id"], event_type="forwarded").exists()
    assert AuditLog.objects.filter(action="forward", target_id=str(root["id"])).exists()


def test_outsider_cannot_forward(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]])
    body = {
        "to_user_ids": [str(office["r2"].id)],
        "mls_group_id": b64(__import__("os").urandom(16)),
        "client_ref": str(uuid.uuid4()),
    }
    assert api_client.post(f"{CORR_URL}{root['id']}/forward/", body, format="json",
                           **office["h_o"]).status_code == 403


# --- folders + search ---------------------------------------------------------------------

def test_folder_flags_are_per_user(api_client, office):
    sent = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]], [office["r2"]])
    flags = f"{CORR_URL}{sent['id']}/flags/"
    assert api_client.post(flags, {"archived": True, "important": True}, format="json",
                           **office["h_r1"]).status_code == 200
    assert sent["id"] not in _ids(api_client.get(f"{CORR_URL}?folder=inbox", **office["h_r1"]))
    assert sent["id"] in _ids(api_client.get(f"{CORR_URL}?folder=archived", **office["h_r1"]))
    assert sent["id"] in _ids(api_client.get(f"{CORR_URL}?folder=important", **office["h_r1"]))
    # r2's view is untouched
    assert sent["id"] in _ids(api_client.get(f"{CORR_URL}?folder=inbox", **office["h_r2"]))
    assert sent["id"] not in _ids(api_client.get(f"{CORR_URL}?folder=important", **office["h_r2"]))
    counts = api_client.get(f"{CORR_URL}counts/", **office["h_r2"]).json()
    assert counts["inbox_unread"] == 1


def test_server_search_matches_reference_metadata_only(api_client, office):
    """SEC-12: the server has no plaintext index; only reference numbers match."""
    canary = "CANARY-search-term-91c2"
    payload = b"\x14" + canary.encode() + mls_payload(16)
    sent = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]], payload=payload)
    by_ref = api_client.get(f"{CORR_URL}?folder=inbox&q={sent['reference_number'][-6:]}", **office["h_r1"])
    assert sent["id"] in _ids(by_ref)
    by_content = api_client.get(f"{CORR_URL}?folder=inbox&q={canary}", **office["h_r1"])
    assert _ids(by_content) == []
    # and nobody else gets a hit on its reference either
    other = api_client.get(f"{CORR_URL}?folder=inbox&q={sent['reference_number']}", **office["h_o"])
    assert _ids(other) == []


def test_unknown_folder_is_rejected(api_client, office):
    assert api_client.get(f"{CORR_URL}?folder=everything", **office["h_s"]).status_code == 400
