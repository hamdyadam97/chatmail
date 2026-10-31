"""Correspondence privacy gates.

SEC-01/02: a branch manager and a sys_admin get 403 on EVERY object endpoint
of an employee's correspondence (detail, events, send, reply, forward, read,
flags, close, the thread's MLS stream, its WS ticket, its attachments) and see
nothing of it in any folder or search.
SEC-13: attachments download only for participants; ids are unguessable and
guessing answers 403; sharing a file you cannot access is refused. Files and
their names are sealed at rest.
SEC-10: canaries in subject/body/file never reach audit rows, events or disk
readable.
"""
import uuid

import pytest

from apps.audit.models import AuditLog
from apps.correspondence.models import CorrespondenceEvent, StoredFile

from .conftest import assign_role
from .correspondence_utils import (  # noqa: F401  (fixtures)
    ATT_URL,
    CONV_URL,
    CORR_URL,
    _blob_root,
    compose,
    forward,
    make_employee,
    office,
    prepare_and_send,
    reply,
    upload,
)
from .messaging_utils import auth

pytestmark = pytest.mark.django_db


@pytest.fixture
def privileged(api_client, user_factory, branch_a, office):
    manager = make_employee(user_factory, "c_mgr", branch_a)
    assign_role(manager, "branch_manager", branch=branch_a, institute=branch_a.institute)
    admin = user_factory("c_admin", membership_unit=branch_a)
    assign_role(admin, "sys_admin")
    return {
        "manager": manager,
        "admin": admin,
        "h_manager": auth(api_client, "c_mgr"),
        "h_admin": auth(api_client, "c_admin"),
    }


def _ids(resp):
    return [item["id"] for item in resp.json()["results"]]


@pytest.mark.parametrize("who", ["manager", "admin"])
def test_privileged_roles_cannot_touch_employee_correspondence(api_client, office, privileged, who):
    blob = upload(api_client, office["h_s"]).json()
    sent = prepare_and_send(api_client, office["h_s"], [office["r1"]],
                            attachment_ids=[blob["id"]])
    h = privileged[f"h_{who}"]
    cid = sent["id"]

    assert api_client.get(f"{CORR_URL}{cid}/", **h).status_code == 403
    assert api_client.get(f"{CORR_URL}{cid}/events/", **h).status_code == 403
    assert api_client.post(f"{CORR_URL}{cid}/send/", **h).status_code == 403
    assert api_client.patch(f"{CORR_URL}{cid}/", {"subject": "x"}, format="json", **h).status_code == 403
    assert reply(api_client, h, cid).status_code == 403
    assert forward(api_client, h, cid, [privileged[who]]).status_code == 403
    assert api_client.post(f"{CORR_URL}{cid}/read/", **h).status_code == 403
    assert api_client.post(f"{CORR_URL}{cid}/flags/", {"important": True}, format="json",
                           **h).status_code == 403
    assert api_client.post(f"{CORR_URL}{cid}/close/", **h).status_code == 403
    assert api_client.delete(f"{CORR_URL}{cid}/", **h).status_code == 403
    assert api_client.get(f"{CONV_URL}{sent['thread_id']}/messages/", **h).status_code == 403
    assert api_client.get(f"{CONV_URL}{sent['thread_id']}/ws-ticket/", **h).status_code == 403
    assert api_client.get(f"{ATT_URL}{blob['id']}/", **h).status_code == 403

    for folder in ("inbox", "sent", "drafts", "archived", "important", "pending_replies"):
        for q in (sent["reference_number"], "عنوان"):
            listing = api_client.get(f"{CORR_URL}?folder={folder}&q={q}", **h)
            assert cid not in _ids(listing)

    denials = AuditLog.objects.filter(action="unauthorized_access_denied", actor=privileged[who])
    assert denials.count() >= 10


def test_unknown_and_forbidden_ids_are_indistinguishable(api_client, office):
    sent = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    real = api_client.get(f"{CORR_URL}{sent['id']}/", **office["h_o"])
    fake = api_client.get(f"{CORR_URL}{uuid.uuid4()}/", **office["h_o"])
    assert real.status_code == fake.status_code == 403
    assert real.json() == fake.json()


# --- SEC-13 attachments -------------------------------------------------------------

def test_attachment_download_follows_participation(api_client, office):
    data = b"%PDF-1.7 " + "تقرير سري".encode()
    up = upload(api_client, office["h_s"], data, name="تقرير.pdf")
    assert up.status_code == 201, up.content
    assert up.json()["name"] == "تقرير.pdf" and up.json()["size"] == len(data)
    blob_id = up.json()["id"]
    stored = StoredFile.objects.get(id=blob_id)
    on_disk = (stored_root(office) / stored.storage_key).read_bytes()
    assert data not in on_disk and "تقرير".encode() not in bytes(stored.meta_enc)

    # before binding: uploader only
    assert api_client.get(f"{ATT_URL}{blob_id}/", **office["h_s"]).status_code == 200
    assert api_client.get(f"{ATT_URL}{blob_id}/", **office["h_r1"]).status_code == 403

    sent = prepare_and_send(api_client, office["h_s"], [office["r1"]], attachment_ids=[blob_id])
    assert [a["name"] for a in sent["content"]["attachments"]] == ["تقرير.pdf"]
    got = api_client.get(f"{ATT_URL}{blob_id}/", **office["h_r1"])
    assert got.status_code == 200
    assert got.content == data
    assert got["Content-Type"] == "application/octet-stream"
    assert got["Content-Disposition"].startswith("attachment;")
    assert got["Cache-Control"] == "no-store"
    assert api_client.get(f"{ATT_URL}{blob_id}/", **office["h_o"]).status_code == 403
    assert api_client.get(f"{ATT_URL}{uuid.uuid4()}/", **office["h_o"]).status_code == 403


def stored_root(office):
    from django.conf import settings

    return settings.ENCRYPTED_BLOB_ROOT


def test_cannot_attach_a_file_you_cannot_access(api_client, office):
    foreign = upload(api_client, office["h_o"]).json()["id"]
    resp = compose(api_client, office["h_s"], [office["r1"]], attachment_ids=[foreign])
    assert resp.status_code == 403


def test_forward_reshares_attachment_to_new_recipient_only(api_client, office):
    blob_id = upload(api_client, office["h_s"]).json()["id"]
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]], attachment_ids=[blob_id])
    assert api_client.get(f"{ATT_URL}{blob_id}/", **office["h_o"]).status_code == 403
    fwd = forward(api_client, office["h_r1"], root["id"], [office["o"]])
    assert fwd.status_code == 201, fwd.content
    assert [a["id"] for a in fwd.json()["content"]["attachments"]] == [blob_id]
    assert api_client.get(f"{ATT_URL}{blob_id}/", **office["h_o"]).status_code == 200
    assert api_client.get(f"{ATT_URL}{blob_id}/", **office["h_r2"]).status_code == 403


def test_empty_or_oversized_file_is_refused(api_client, office, settings):
    assert upload(api_client, office["h_s"], b"").status_code == 400
    settings.ENCRYPTED_ATTACHMENT_MAX_BYTES = 1024
    assert upload(api_client, office["h_s"], b"x" * 2048).status_code == 400


def test_upload_requires_authentication(api_client):
    assert upload(api_client, {}).status_code == 401


# --- SEC-10 canaries ---------------------------------------------------------------------

CANARY = "CANARY-corr-5e1d0c77-body"


def test_canary_never_reaches_audit_events_or_storage(api_client, office):
    from django.conf import settings

    from apps.messaging.models import Message

    blob_id = upload(api_client, office["h_s"], CANARY.encode(), name=f"{CANARY}.txt").json()["id"]
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]], subject=CANARY, body=CANARY,
                            attachment_ids=[blob_id])
    reply(api_client, office["h_r1"], root["id"], subject=CANARY, body=CANARY)
    api_client.post(f"{CORR_URL}{root['id']}/read/", **office["h_r1"])

    for row in AuditLog.objects.all():
        assert CANARY not in repr(row.metadata)
        assert CANARY not in (row.target_type or "") + str(row.target_id or "")
    for event in CorrespondenceEvent.objects.all():
        assert CANARY not in repr(event.metadata)
    for blob in Message.objects.values_list("content_enc", flat=True):
        assert CANARY.encode() not in bytes(blob)
    for path in settings.ENCRYPTED_BLOB_ROOT.rglob("*"):
        if path.is_file():
            assert CANARY.encode() not in path.read_bytes()
