"""WebSocket delivery: ticket auth (single use), chat.event forwarding,
membership-revocation self-close."""
import pytest
import pytest_asyncio
from asgiref.sync import sync_to_async
from channels.testing import WebsocketCommunicator

from apps.messaging.models import Conversation

from .conftest import DEFAULT_PASSWORD
from .messaging_utils import CONV_URL, create_conversation, post_message
from config.asgi import application

pytestmark = [pytest.mark.django_db(transaction=True)]


async def _login_token(api_client, username):
    from .conftest import login

    resp = await sync_to_async(login)(api_client, username, DEFAULT_PASSWORD)
    return resp.json()["access"]


async def _headers(api_client, username):
    from .conftest import auth_headers

    token = await _login_token(api_client, username)
    return auth_headers(token)


async def _get_ticket(api_client, conv_id, headers):
    r = await sync_to_async(api_client.get)(
        f"{CONV_URL}{conv_id}/ws-ticket/", **headers
    )
    assert r.status_code == 200, r.json()
    return r.json()["ticket"]


async def _connect(api_client, conv_id, username):
    headers = await _headers(api_client, username)
    ticket = await _get_ticket(api_client, conv_id, headers)
    communicator = WebsocketCommunicator(
        application, f"/ws/conversations/{conv_id}/?ticket={ticket}"
    )
    connected, _ = await communicator.connect()
    assert connected, f"WS connect failed for {username}"
    return communicator, headers


@pytest_asyncio.fixture
async def group(api_client, user_factory):
    a = await sync_to_async(user_factory)("ws_a")
    b = await sync_to_async(user_factory)("ws_b")
    h_a = await _headers(api_client, "ws_a")
    h_b = await _headers(api_client, "ws_b")
    r = await sync_to_async(create_conversation)(api_client, h_a, "group", [b.id])
    conv_id = r.json()["id"]
    return {
        "a": a, "b": b, "h_a": h_a, "h_b": h_b,
        "conv_id": conv_id,
        "api_client": api_client,
    }


@pytest.mark.asyncio
async def test_ws_forwards_chat_event(group):
    communicator, h_b = await _connect(group["api_client"], group["conv_id"], "ws_b")
    try:
        r = await sync_to_async(post_message)(group["api_client"], group["h_a"], group["conv_id"], "مرحبا")
        assert r.status_code == 201
        frame = await communicator.receive_json_from()
        assert frame["type"] == "chat.event"
        assert frame["event"] == "message"
        assert frame["conversation_id"] == group["conv_id"]
        assert frame["seq"] == 1
        assert frame["sender_user_id"] == str(group["a"].id)
        assert frame["content"] == {"text": "مرحبا"}
        assert frame["reply_to_seq"] is None
        assert frame["created_at"]
    finally:
        await communicator.disconnect()


@pytest.mark.asyncio
async def test_ws_ping_pong(group):
    communicator, _ = await _connect(group["api_client"], group["conv_id"], "ws_a")
    try:
        await communicator.send_json_to({"type": "ping"})
        pong = await communicator.receive_json_from()
        assert pong == {"type": "pong"}
    finally:
        await communicator.disconnect()


@pytest.mark.asyncio
async def test_ws_ticket_is_single_use(group):
    headers = await _headers(group["api_client"], "ws_a")
    ticket = await _get_ticket(group["api_client"], group["conv_id"], headers)
    first = WebsocketCommunicator(
        application, f"/ws/conversations/{group['conv_id']}/?ticket={ticket}"
    )
    connected, _ = await first.connect()
    assert connected
    await first.disconnect()
    second = WebsocketCommunicator(
        application, f"/ws/conversations/{group['conv_id']}/?ticket={ticket}"
    )
    connected, _ = await second.connect()
    assert connected is False
    await second.disconnect()


@pytest.mark.asyncio
async def test_ws_bad_ticket_rejected(group):
    communicator = WebsocketCommunicator(
        application,
        f"/ws/conversations/{group['conv_id']}/?ticket=not-a-ticket",
    )
    connected, _ = await communicator.connect()
    assert connected is False
    await communicator.disconnect()


@pytest.mark.asyncio
async def test_ws_membership_revoked_self_close(group):
    communicator, h_b = await _connect(group["api_client"], group["conv_id"], "ws_b")
    try:
        r = await sync_to_async(group["api_client"].post)(
            f"{CONV_URL}{group['conv_id']}/members/remove/",
            {"user_ids": [str(group["b"].id)]},
            format="json",
            **group["h_a"],
        )
        assert r.status_code == 200
        frame = await communicator.receive_json_from()
        assert frame["event"] == "member_removed"
        assert str(group["b"].id) in frame["user_ids"]
        close = await communicator.receive_output()
        assert close["type"] == "websocket.close"
        assert close["code"] == 4002
    finally:
        await communicator.disconnect()


@pytest.mark.asyncio
async def test_ws_removed_member_cannot_connect(group):
    await sync_to_async(group["api_client"].post)(
        f"{CONV_URL}{group['conv_id']}/members/remove/",
        {"user_ids": [str(group["b"].id)]},
        format="json",
        **group["h_a"],
    )
    headers = await _headers(group["api_client"], "ws_b")
    # ws-ticket endpoint itself refuses (membership gate, no ticket minted)
    r = await sync_to_async(group["api_client"].get)(
        f"{CONV_URL}{group['conv_id']}/ws-ticket/", **headers
    )
    assert r.status_code == 403
