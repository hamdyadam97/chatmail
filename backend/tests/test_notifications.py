"""Notifications: generic titles only (SEC-11), own rows only, WS push."""
import pytest
from asgiref.sync import sync_to_async
from channels.testing import WebsocketCommunicator

from apps.notifications.models import Notification
from apps.notifications.services import TITLES

from .correspondence_utils import (  # noqa: F401  (fixtures)
    _blob_root,
    office,
    prepare_and_send,
    reply,
)

NOTIF_URL = "/api/v1/notifications/"
CANARY = "CANARY-notif-3b7e-subject"


@pytest.mark.django_db
def test_correspondence_notifications_are_generic(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]], [office["r2"]], subject=CANARY)
    rows = Notification.objects.filter(ref_id=root["id"])
    assert {(str(n.user_id), n.kind) for n in rows} == {
        (str(office["r1"].id), "new_correspondence"),
        (str(office["r2"].id), "new_correspondence"),
    }
    assert reply(api_client, office["h_r1"], root["id"], subject=CANARY).status_code == 201
    assert Notification.objects.filter(kind="correspondence_reply", user=office["s"]).exists()
    assert not Notification.objects.filter(kind="correspondence_reply", user=office["r1"]).exists()

    for n in Notification.objects.all():
        assert n.title_generic == TITLES[n.kind]
        assert CANARY not in n.title_generic
    listing = api_client.get(NOTIF_URL, **office["h_r2"]).json()
    assert CANARY not in str(listing)
    assert listing["count"] == 2  # root + reply (r2 is cc on both)


@pytest.mark.django_db
def test_notifications_are_private_to_their_owner(api_client, office):
    prepare_and_send(api_client, office["h_s"], [office["r1"]])
    mine = Notification.objects.get(user=office["r1"])
    assert api_client.get(NOTIF_URL, **office["h_o"]).json()["count"] == 0
    assert api_client.post(f"{NOTIF_URL}{mine.id}/read/", **office["h_o"]).status_code == 403
    assert api_client.get(f"{NOTIF_URL}unread-count/", **office["h_r1"]).json() == {"unread": 1}
    assert api_client.post(f"{NOTIF_URL}{mine.id}/read/", **office["h_r1"]).status_code == 204
    assert api_client.get(f"{NOTIF_URL}unread-count/", **office["h_r1"]).json() == {"unread": 0}
    prepare_and_send(api_client, office["h_s"], [office["r1"]])
    assert api_client.post(f"{NOTIF_URL}read-all/", **office["h_r1"]).status_code == 204
    assert api_client.get(f"{NOTIF_URL}?unread=1", **office["h_r1"]).json()["count"] == 0


@pytest.mark.django_db
def test_preferences_validate_kinds(api_client, office):
    url = f"{NOTIF_URL}preferences/"
    assert api_client.put(url, {"muted_kinds": ["nope"]}, format="json", **office["h_r1"]).status_code == 400
    ok = api_client.put(url, {"muted_kinds": ["device_alert"]}, format="json", **office["h_r1"])
    assert ok.json() == {"muted_kinds": ["device_alert"]}


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_pushes_generic_notification(api_client, user_factory):
    """Transactional tests flush migration seed data, so this one avoids org
    fixtures: it fires notify() directly (the correspondence → notify link is
    covered by test_correspondence_notifications_are_generic)."""
    import uuid

    from config.asgi import application

    from apps.notifications.services import notify

    from .messaging_utils import auth

    user = await sync_to_async(user_factory)("n_ws")
    other = await sync_to_async(user_factory)("n_ws_other")
    headers = await sync_to_async(auth)(api_client, "n_ws")
    ticket = (await sync_to_async(api_client.get)(f"{NOTIF_URL}ws-ticket/", **headers)).json()["ticket"]
    comm = WebsocketCommunicator(application, f"/ws/notifications/?ticket={ticket}")
    assert (await comm.connect())[0]
    # a ticket is single-use
    again = WebsocketCommunicator(application, f"/ws/notifications/?ticket={ticket}")
    connected, code = await again.connect()
    assert not connected or code == 4401

    ref = uuid.uuid4()
    await sync_to_async(notify)([other.id], "new_correspondence", ref_type="correspondence", ref_id=uuid.uuid4())
    await sync_to_async(notify)([user.id], "new_correspondence", ref_type="correspondence", ref_id=ref)
    frame = await comm.receive_json_from(timeout=5)
    assert frame["type"] == "notification"
    assert frame["notification"]["kind"] == "new_correspondence"
    assert frame["notification"]["ref_id"] == str(ref)  # only my own notification arrives
    assert frame["notification"]["title"] == TITLES["new_correspondence"]
    assert await comm.receive_nothing(timeout=0.3)
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_rejects_garbage_ticket():
    from config.asgi import application

    comm = WebsocketCommunicator(application, "/ws/notifications/?ticket=garbage")
    connected, code = await comm.connect()
    assert not connected or code == 4401
