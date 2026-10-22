"""Shared helpers for the messaging test suites."""
import base64
import os
import uuid

from apps.accounts.models import TrustedDevice

from .conftest import DEFAULT_PASSWORD, auth_headers, login

CONV_URL = "/api/v1/conversations/"


def make_device(user, label="dev", status="active"):
    return TrustedDevice.objects.create(
        user=user, device_label=label, platform="test", status=status
    )


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def mls_payload(n=64, prefix=0x14) -> bytes:
    """Fake-but-plausible MLS wire payload (framing byte + entropy)."""
    return bytes([prefix]) + os.urandom(n)


def auth(client, username, password=DEFAULT_PASSWORD):
    resp = login(client, username, password)
    return auth_headers(resp.json()["access"])


def create_conversation(client, headers, type, member_ids, with_title=True):
    body = {
        "type": type,
        "member_user_ids": [str(i) for i in member_ids],
        "mls_group_id": b64(os.urandom(16)),
    }
    if with_title:
        body["title_enc"] = b64(b"\x14opaque-ciphertext-title")
    return client.post(CONV_URL, body, format="json", **headers)


def post_message(
    client,
    headers,
    conv_id,
    kind,
    payload,
    *,
    client_msg_id=None,
    epoch=1,
    sender_device_id=None,
    recipient_device_id=None,
    reply_to_seq=None,
    membership=None,
):
    body = {
        "kind": kind,
        "mls_payload": b64(payload),
        "client_msg_id": str(client_msg_id or uuid.uuid4()),
        "epoch": epoch,
    }
    if sender_device_id:
        body["sender_device_id"] = str(sender_device_id)
    if recipient_device_id:
        body["recipient_device_id"] = str(recipient_device_id)
    if reply_to_seq is not None:
        body["reply_to_seq"] = reply_to_seq
    if membership:
        body["membership"] = membership
    return client.post(f"{CONV_URL}{conv_id}/messages/", body, format="json", **headers)


def commit(client, headers, conv_id, device_id, epoch, membership=None, payload=None):
    return post_message(
        client,
        headers,
        conv_id,
        "commit",
        payload if payload is not None else mls_payload(),
        epoch=epoch,
        sender_device_id=device_id,
        membership=membership,
    )
