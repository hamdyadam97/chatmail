"""Shared helpers for the correspondence suites."""
import uuid

import pytest

from .conftest import assign_role
from .messaging_utils import CONV_URL, auth

CORR_URL = "/api/v1/correspondences/"
ATT_URL = "/api/v1/attachments/"


def make_employee(user_factory, username, branch):
    """A user in `branch` holding the seeded employee role at its institute."""
    user = user_factory(username, membership_unit=branch)
    assign_role(user, "employee", institute=branch.institute)
    return user


def compose(client, headers, to, cc=(), *, subject="عنوان", body="نص المراسلة", send=True,
            attachment_ids=(), client_ref=None, **extra):
    data = {
        "to_user_ids": [str(u.id) for u in to],
        "cc_user_ids": [str(u.id) for u in cc],
        "subject": subject,
        "body": body,
        "attachment_ids": [str(a) for a in attachment_ids],
        "client_ref": str(client_ref or uuid.uuid4()),
        "send": send,
        **extra,
    }
    return client.post(CORR_URL, data, format="json", **headers)


def prepare_and_send(client, headers, to, cc=(), **kwargs):
    sent = compose(client, headers, to, cc, **kwargs)
    assert sent.status_code == 201, sent.content
    return sent.json()


def reply(client, headers, corr_id, *, subject="رد", body="نص الرد", attachment_ids=(), client_ref=None,
          **extra):
    data = {
        "client_ref": str(client_ref or uuid.uuid4()),
        "subject": subject,
        "body": body,
        "attachment_ids": [str(a) for a in attachment_ids],
        **extra,
    }
    return client.post(f"{CORR_URL}{corr_id}/reply/", data, format="json", **headers)


def forward(client, headers, corr_id, to, *, body="للاطلاع", send=True, **extra):
    data = {
        "to_user_ids": [str(u.id) for u in to],
        "body": body,
        "client_ref": str(uuid.uuid4()),
        "send": send,
        **extra,
    }
    return client.post(f"{CORR_URL}{corr_id}/forward/", data, format="json", **headers)


def upload(client, headers, data: bytes = b"%PDF-1.7 report", name="report.pdf"):
    from django.core.files.uploadedfile import SimpleUploadedFile

    return client.post(
        ATT_URL, {"file": SimpleUploadedFile(name, data, content_type="application/pdf")},
        format="multipart", **headers,
    )


@pytest.fixture(autouse=True)
def _blob_root(settings, tmp_path):
    settings.ENCRYPTED_BLOB_ROOT = tmp_path / "blobs"


@pytest.fixture
def office(api_client, user_factory, branch_a):
    """Sender `s` and recipients `r1` (to), `r2` (cc), outsider `o` — all
    employees of AHL/RYD."""
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
    }


__all__ = ["CONV_URL", "CORR_URL", "ATT_URL", "auth"]
