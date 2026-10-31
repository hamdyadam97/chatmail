"""Shared helpers for the messaging test suites."""
import uuid

from apps.accounts.models import TrustedDevice

from .conftest import DEFAULT_PASSWORD, auth_headers, login

CONV_URL = "/api/v1/conversations/"


def make_device(user, label="dev", status="active"):
    return TrustedDevice.objects.create(
        user=user, device_label=label, platform="test", status=status
    )


def auth(client, username, password=DEFAULT_PASSWORD):
    resp = login(client, username, password)
    return auth_headers(resp.json()["access"])


def create_conversation(client, headers, type, member_ids, title=""):
    body = {"type": type, "member_user_ids": [str(i) for i in member_ids]}
    if title:
        body["title"] = title
    return client.post(CONV_URL, body, format="json", **headers)


def post_message(client, headers, conv_id, text="hello", *, client_msg_id=None, reply_to_seq=None):
    body = {"text": text, "client_msg_id": str(client_msg_id or uuid.uuid4())}
    if reply_to_seq is not None:
        body["reply_to_seq"] = reply_to_seq
    return client.post(f"{CONV_URL}{conv_id}/messages/", body, format="json", **headers)
