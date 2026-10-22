"""Shared helpers for the correspondence suites."""
import base64
import json
import os
import uuid

import pytest

from .conftest import assign_role
from .messaging_utils import CONV_URL, auth, commit, make_device, mls_payload

CORR_URL = "/api/v1/correspondences/"
ATT_URL = "/api/v1/attachments/"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def make_employee(user_factory, username, branch):
    """A user in `branch` holding the seeded employee role at its institute."""
    user = user_factory(username, membership_unit=branch)
    assign_role(user, "employee", institute=branch.institute)
    return user


def prepare(client, headers, to, cc=(), **extra):
    body = {
        "to_user_ids": [str(u.id) for u in to],
        "cc_user_ids": [str(u.id) for u in cc],
        "mls_group_id": b64(os.urandom(16)),
        "client_ref": str(uuid.uuid4()),
        **extra,
    }
    return client.post(CORR_URL, body, format="json", **headers)


def send(client, headers, corr_id, device_id, *, epoch=1, payload=None, client_msg_id=None,
         attachment_ids=()):
    body = {
        "mls_payload": b64(payload if payload is not None else mls_payload()),
        "client_msg_id": str(client_msg_id or uuid.uuid4()),
        "epoch": epoch,
        "sender_device_id": str(device_id),
        "attachment_ids": [str(a) for a in attachment_ids],
    }
    return client.post(f"{CORR_URL}{corr_id}/send/", body, format="json", **headers)


def setup_thread(client, headers, thread_id, device_id):
    """Simulate the client's MLS group setup: Commit epoch 1 (Welcomes are
    irrelevant to the server-side gates exercised here)."""
    resp = commit(client, headers, thread_id, device_id, epoch=1)
    assert resp.status_code == 201, resp.content
    return resp


def prepare_and_send(client, headers, device_id, to, cc=(), payload=None, attachment_ids=(), **extra):
    prepared = prepare(client, headers, to, cc, **extra)
    assert prepared.status_code == 201, prepared.content
    data = prepared.json()
    setup_thread(client, headers, data["thread"]["id"], device_id)
    sent = send(client, headers, data["id"], device_id, payload=payload, attachment_ids=attachment_ids)
    assert sent.status_code == 200, sent.content
    return sent.json()


def reply(client, headers, corr_id, device_id, epoch=1, payload=None, attachment_ids=(), client_ref=None):
    body = {
        "client_ref": str(client_ref or uuid.uuid4()),
        "mls_payload": b64(payload if payload is not None else mls_payload()),
        "client_msg_id": str(uuid.uuid4()),
        "epoch": epoch,
        "sender_device_id": str(device_id),
        "attachment_ids": [str(a) for a in attachment_ids],
    }
    return client.post(f"{CORR_URL}{corr_id}/reply/", body, format="json", **headers)


def upload(client, headers, data: bytes):
    return client.post(ATT_URL, data=data, content_type="application/octet-stream", **headers)


def encrypted_blob(n=256) -> bytes:
    # IV(12) || ciphertext — random bytes stand in for AES-GCM output.
    while True:
        data = os.urandom(n)
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            return data


def json_text_payload() -> bytes:
    return json.dumps({"subject": "plain subject", "body": "plain body"}).encode()


@pytest.fixture(autouse=True)
def _blob_root(settings, tmp_path):
    settings.ENCRYPTED_BLOB_ROOT = tmp_path / "blobs"


@pytest.fixture
def office(api_client, user_factory, branch_a):
    """Sender `s` and recipients `r1` (to), `r2` (cc), outsider `o` — all
    employees of AHL/RYD with active devices."""
    s = make_employee(user_factory, "c_sender", branch_a)
    r1 = make_employee(user_factory, "c_rcpt1", branch_a)
    r2 = make_employee(user_factory, "c_rcpt2", branch_a)
    o = make_employee(user_factory, "c_out", branch_a)
    return {
        "s": s, "r1": r1, "r2": r2, "o": o,
        "h_s": auth(api_client, "c_sender"),
        "h_r1": auth(api_client, "c_rcpt1"),
        "h_r2": auth(api_client, "c_rcpt2"),
        "h_o": auth(api_client, "c_out"),
        "d_s": make_device(s).id,
        "d_r1": make_device(r1).id,
        "d_r2": make_device(r2).id,
        "d_o": make_device(o).id,
    }


__all__ = [
    "CONV_URL", "CORR_URL", "ATT_URL", "auth", "make_device", "mls_payload", "commit",
]
