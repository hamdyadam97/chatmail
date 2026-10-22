"""Object-permission gates: non-members and removed members get 403 everywhere.

SEC-01/02: no role (sysadmin or manager) bypasses the membership gate —
authorization here derives exclusively from conversation_members rows.
"""
import pytest

from apps.messaging.models import ConversationMember

from .messaging_utils import (
    CONV_URL,
    auth,
    commit,
    create_conversation,
    make_device,
    mls_payload,
)

pytestmark = pytest.mark.django_db


@pytest.fixture
def group(user_factory, api_client):
    """Group with admin a, member b; returns ids/handlers."""
    a = user_factory("perm_a")
    b = user_factory("perm_b")
    outsider = user_factory("perm_out")
    h_a = auth(api_client, "perm_a")
    h_b = auth(api_client, "perm_b")
    h_out = auth(api_client, "perm_out")
    conv_id = create_conversation(api_client, h_a, "group", [b.id]).json()["id"]
    return {
        "a": a,
        "b": b,
        "outsider": outsider,
        "h_a": h_a,
        "h_b": h_b,
        "h_out": h_out,
        "conv_id": conv_id,
        "device_a": make_device(a),
    }


def test_non_member_forbidden_everywhere(api_client, group):
    conv_id = group["conv_id"]
    h = group["h_out"]
    new_user_payload = {
        "kind": "application",
        "mls_payload": __import__("base64").b64encode(mls_payload()).decode(),
        "client_msg_id": "12345678-1234-1234-1234-123456789012",
        "epoch": 1,
        "sender_device_id": str(make_device(group["outsider"]).id),
    }
    assert api_client.get(f"{CONV_URL}{conv_id}/messages/", **h).status_code == 403
    r = api_client.post(
        f"{CONV_URL}{conv_id}/messages/", new_user_payload, format="json", **h
    )
    assert r.status_code == 403
    assert api_client.post(
        f"{CONV_URL}{conv_id}/members/", {"user_ids": [str(group["outsider"].id)]},
        format="json", **h,
    ).status_code == 403
    assert api_client.post(
        f"{CONV_URL}{conv_id}/members/remove/", {"user_ids": [str(group["b"].id)]},
        format="json", **h,
    ).status_code == 403
    assert api_client.get(f"{CONV_URL}{conv_id}/ws-ticket/", **h).status_code == 403


def test_removed_member_forbidden_everywhere(api_client, group):
    conv_id = group["conv_id"]
    api_client.post(
        f"{CONV_URL}{conv_id}/members/remove/",
        {"user_ids": [str(group["b"].id)]},
        format="json",
        **group["h_a"],
    )
    h = group["h_b"]
    payload = {
        "kind": "application",
        "mls_payload": __import__("base64").b64encode(mls_payload()).decode(),
        "client_msg_id": "12345678-1234-1234-1234-123456789012",
        "epoch": 1,
        "sender_device_id": str(make_device(group["b"]).id),
    }
    assert api_client.get(f"{CONV_URL}{conv_id}/messages/", **h).status_code == 403
    assert api_client.post(
        f"{CONV_URL}{conv_id}/messages/", payload, format="json", **h
    ).status_code == 403
    assert api_client.get(f"{CONV_URL}{conv_id}/ws-ticket/", **h).status_code == 403
    # removal is idempotent and visible on the row
    member = ConversationMember.objects.get(
        conversation_id=conv_id, user=group["b"]
    )
    assert member.removed_at is not None


def test_removed_at_acl_blocks_fetch_even_without_client_rotation(api_client, group):
    """The server's ACL is enforced immediately at removal; clients rotating
    the MLS epoch (Remove proposal + Commit) is the cryptographic half — this
    slice proves the API half stands alone (AGENTS.md rule 5)."""
    conv_id = group["conv_id"]
    commit(
        api_client, group["h_a"], conv_id, group["device_a"].id, epoch=1
    )
    # b read the epoch-1 history legitimately...
    assert api_client.get(f"{CONV_URL}{conv_id}/messages/", **group["h_b"]).status_code == 200
    # ...is removed by admin (no commit/rotation performed by any client)...
    api_client.post(
        f"{CONV_URL}{conv_id}/members/remove/",
        {"user_ids": [str(group["b"].id)]},
        format="json",
        **group["h_a"],
    )
    # ...and instantly loses all access.
    assert api_client.get(f"{CONV_URL}{conv_id}/messages/", **group["h_b"]).status_code == 403


def test_non_admin_member_cannot_add_or_remove(api_client, group):
    conv_id = group["conv_id"]
    h_b = group["h_b"]
    assert api_client.post(
        f"{CONV_URL}{conv_id}/members/", {"user_ids": [str(group["outsider"].id)]},
        format="json", **h_b,
    ).status_code == 403
    assert api_client.post(
        f"{CONV_URL}{conv_id}/members/remove/", {"user_ids": [str(group["a"].id)]},
        format="json", **h_b,
    ).status_code == 403


def test_sysadmin_without_membership_still_forbidden(api_client, group, user_factory, role_factory):
    """SEC-02: sys_admin role does NOT bypass the object-permission gate."""
    admin = user_factory("perm_sys")
    role_factory(admin, "sys_admin")
    h = auth(api_client, "perm_sys")
    conv_id = group["conv_id"]
    assert api_client.get(f"{CONV_URL}{conv_id}/messages/", **h).status_code == 403
    assert api_client.get(f"{CONV_URL}{conv_id}/ws-ticket/", **h).status_code == 403


def test_members_add_and_remove_admin_flow(api_client, group):
    conv_id = group["conv_id"]
    r = api_client.post(
        f"{CONV_URL}{conv_id}/members/",
        {"user_ids": [str(group["outsider"].id)]},
        format="json",
        **group["h_a"],
    )
    assert r.status_code == 201
    assert group["outsider"].id in [
        ConversationMember.objects.get(conversation_id=conv_id, user=group["outsider"]).user_id
    ]
    r = api_client.post(
        f"{CONV_URL}{conv_id}/members/remove/",
        {"user_ids": [str(group["outsider"].id)]},
        format="json",
        **group["h_a"],
    )
    assert r.status_code == 200
    assert ConversationMember.objects.get(
        conversation_id=conv_id, user=group["outsider"]
    ).removed_at is not None
