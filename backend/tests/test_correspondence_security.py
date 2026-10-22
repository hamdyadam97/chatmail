"""Correspondence privacy gates.

SEC-01/02: a branch manager and a sys_admin get 403 on EVERY object endpoint
of an employee's correspondence (detail, events, send, reply, forward, read,
flags, close, the thread's MLS stream, its WS ticket, its attachments) and see
nothing of it in any folder or search.
SEC-13: attachment blobs download only for participants; ids are unguessable
and guessing answers 403; sharing a blob you cannot access is refused.
SEC-10: canaries inside ciphertext never reach audit rows or events.
"""
import os
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
    b64,
    encrypted_blob,
    make_employee,
    mls_payload,
    office,
    prepare,
    prepare_and_send,
    reply,
    send,
    setup_thread,
    upload,
)
from .messaging_utils import auth, make_device

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
        "d_manager": make_device(manager).id,
        "d_admin": make_device(admin).id,
    }


def _ids(resp):
    return [item["id"] for item in resp.json()["results"]]


@pytest.mark.parametrize("who", ["manager", "admin"])
def test_privileged_roles_cannot_touch_employee_correspondence(api_client, office, privileged, who):
    blob = upload(api_client, office["h_s"], encrypted_blob()).json()
    sent = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]],
                            attachment_ids=[blob["id"]])
    h = privileged[f"h_{who}"]
    device = privileged[f"d_{who}"]
    cid = sent["id"]

    assert api_client.get(f"{CORR_URL}{cid}/", **h).status_code == 403
    assert api_client.get(f"{CORR_URL}{cid}/events/", **h).status_code == 403
    assert send(api_client, h, cid, device).status_code == 403
    assert reply(api_client, h, cid, device).status_code == 403
    fwd = {"to_user_ids": [str(privileged[who].id)], "mls_group_id": b64(os.urandom(16)),
           "client_ref": str(uuid.uuid4())}
    assert api_client.post(f"{CORR_URL}{cid}/forward/", fwd, format="json", **h).status_code == 403
    assert api_client.post(f"{CORR_URL}{cid}/read/", **h).status_code == 403
    assert api_client.post(f"{CORR_URL}{cid}/flags/", {"important": True}, format="json",
                           **h).status_code == 403
    assert api_client.post(f"{CORR_URL}{cid}/close/", **h).status_code == 403
    assert api_client.delete(f"{CORR_URL}{cid}/", **h).status_code == 403
    assert api_client.get(f"{CONV_URL}{sent['thread_id']}/messages/", **h).status_code == 403
    assert api_client.get(f"{CONV_URL}{sent['thread_id']}/ws-ticket/", **h).status_code == 403
    assert api_client.get(f"{ATT_URL}{blob['id']}/", **h).status_code == 403

    for folder in ("inbox", "sent", "drafts", "archived", "important", "pending_replies"):
        listing = api_client.get(f"{CORR_URL}?folder={folder}&q={sent['reference_number']}", **h)
        assert cid not in _ids(listing)

    denials = AuditLog.objects.filter(action="unauthorized_access_denied", actor=privileged[who])
    assert denials.count() >= 10


def test_unknown_and_forbidden_ids_are_indistinguishable(api_client, office):
    sent = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]])
    real = api_client.get(f"{CORR_URL}{sent['id']}/", **office["h_o"])
    fake = api_client.get(f"{CORR_URL}{uuid.uuid4()}/", **office["h_o"])
    assert real.status_code == fake.status_code == 403
    assert real.json() == fake.json()


# --- SEC-13 attachments -------------------------------------------------------------

def test_attachment_download_follows_participation(api_client, office):
    data = encrypted_blob(4096)
    up = upload(api_client, office["h_s"], data)
    assert up.status_code == 201, up.content
    blob_id = up.json()["id"]

    # before binding: uploader only
    assert api_client.get(f"{ATT_URL}{blob_id}/", **office["h_s"]).status_code == 200
    assert api_client.get(f"{ATT_URL}{blob_id}/", **office["h_r1"]).status_code == 403

    sent = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]],
                            attachment_ids=[blob_id])
    assert [a["id"] for a in sent["attachments"]] == [blob_id]
    got = api_client.get(f"{ATT_URL}{blob_id}/", **office["h_r1"])
    assert got.status_code == 200
    assert got.content == data
    assert got["Cache-Control"] == "no-store"
    assert api_client.get(f"{ATT_URL}{blob_id}/", **office["h_o"]).status_code == 403
    assert api_client.get(f"{ATT_URL}{uuid.uuid4()}/", **office["h_o"]).status_code == 403


def test_cannot_attach_a_blob_you_cannot_access(api_client, office):
    foreign = upload(api_client, office["h_o"], encrypted_blob()).json()["id"]
    data = prepare(api_client, office["h_s"], [office["r1"]]).json()
    setup_thread(api_client, office["h_s"], data["thread"]["id"], office["d_s"])
    resp = send(api_client, office["h_s"], data["id"], office["d_s"], attachment_ids=[foreign])
    assert resp.status_code == 403


def test_forward_reshares_attachment_to_new_recipient_only(api_client, office):
    blob_id = upload(api_client, office["h_s"], encrypted_blob()).json()["id"]
    root = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]],
                            attachment_ids=[blob_id])
    assert api_client.get(f"{ATT_URL}{blob_id}/", **office["h_o"]).status_code == 403
    fwd = api_client.post(
        f"{CORR_URL}{root['id']}/forward/",
        {"to_user_ids": [str(office["o"].id)], "mls_group_id": b64(os.urandom(16)),
         "client_ref": str(uuid.uuid4())},
        format="json", **office["h_r1"],
    ).json()
    setup_thread(api_client, office["h_r1"], fwd["thread"]["id"], office["d_r1"])
    assert send(api_client, office["h_r1"], fwd["id"], office["d_r1"],
                attachment_ids=[blob_id]).status_code == 200
    assert api_client.get(f"{ATT_URL}{blob_id}/", **office["h_o"]).status_code == 200
    assert api_client.get(f"{ATT_URL}{blob_id}/", **office["h_r2"]).status_code == 403


@pytest.mark.parametrize(
    "data",
    [
        b"%PDF-1.7\n" + os.urandom(64),
        b"\x89PNG\r\n\x1a\n" + os.urandom(64),
        b"PK\x03\x04" + os.urandom(64),
        "نص عربي غير مشفر — subject and body in the clear".encode(),
        os.urandom(8),
    ],
    ids=["pdf", "png", "zip", "utf8-text", "too-small"],
)
def test_plaintext_or_malformed_blobs_are_refused(api_client, office, data):
    assert upload(api_client, office["h_s"], data).status_code == 400
    assert StoredFile.objects.count() == 0


def test_oversized_blob_is_refused(api_client, office, settings):
    settings.ENCRYPTED_ATTACHMENT_MAX_BYTES = 1024
    assert upload(api_client, office["h_s"], encrypted_blob(2048)).status_code == 400


def test_upload_requires_authentication(api_client):
    assert api_client.post(ATT_URL, data=encrypted_blob(), content_type="application/octet-stream"
                           ).status_code == 401


# --- SEC-10 canaries ---------------------------------------------------------------------

CANARY = "CANARY-corr-5e1d0c77-body"


def test_canary_never_reaches_audit_or_events(api_client, office):
    payload = b"\x14" + CANARY.encode() + mls_payload(32)
    blob = b"\x00\xff" + CANARY.encode() + os.urandom(64)
    blob_id = upload(api_client, office["h_s"], blob).json()["id"]
    root = prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]],
                            payload=payload, attachment_ids=[blob_id])
    reply(api_client, office["h_r1"], root["id"], office["d_r1"], payload=payload)
    api_client.post(f"{CORR_URL}{root['id']}/read/", **office["h_r1"])

    for row in AuditLog.objects.all():
        assert CANARY not in repr(row.metadata)
        assert CANARY not in (row.target_type or "") + str(row.target_id or "")
    for event in CorrespondenceEvent.objects.all():
        assert CANARY not in repr(event.metadata)
