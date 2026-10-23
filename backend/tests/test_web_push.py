"""Web Push: own subscriptions only, SSRF allowlist, generic payloads (SEC-11),
mutes honoured, dead endpoints pruned, chat pushes skip the sender."""
import json
import types

import pytest

from apps.notifications import push
from apps.notifications.models import NotificationPreference, PushSubscription

from .correspondence_utils import (  # noqa: F401  (fixtures)
    _blob_root,
    mls_payload,
    office,
    prepare_and_send,
)
from .messaging_utils import auth, create_conversation, make_device, post_message

PUSH_URL = "/api/v1/notifications/push/"
CANARY = "CANARY-push-91c4-subject"
FCM = "https://fcm.googleapis.com/fcm/send/abc123"


def sub_body(endpoint=FCM):
    return {"endpoint": endpoint, "keys": {"p256dh": "B" * 87, "auth": "a" * 22}}


@pytest.fixture(autouse=True)
def vapid(settings):
    settings.WEB_PUSH_VAPID_PRIVATE_KEY = push.generate_private_key_b64()
    push._private_key.cache_clear()
    yield
    push._private_key.cache_clear()


@pytest.fixture
def sent(monkeypatch):
    """Capture (user_ids, payload) instead of contacting a push service."""
    calls = []
    monkeypatch.setattr(push, "deliver_async", lambda ids, payload: calls.append((set(ids), json.loads(payload))))
    return calls


@pytest.mark.django_db
def test_public_key_and_subscribe_roundtrip(api_client, office):
    info = api_client.get(f"{PUSH_URL}public-key/", **office["h_r1"]).json()
    assert info["enabled"] is True and len(info["public_key"]) == 87

    assert api_client.post(f"{PUSH_URL}subscribe/", sub_body(), format="json", **office["h_r1"]).status_code == 201
    assert PushSubscription.objects.get(endpoint=FCM).user_id == office["r1"].id

    # same browser, another account → the subscription moves (shared computer)
    assert api_client.post(f"{PUSH_URL}subscribe/", sub_body(), format="json", **office["h_r2"]).status_code == 201
    assert PushSubscription.objects.filter(endpoint=FCM).count() == 1
    assert PushSubscription.objects.get(endpoint=FCM).user_id == office["r2"].id

    # unsubscribe only removes the caller's own row
    api_client.post(f"{PUSH_URL}unsubscribe/", {"endpoint": FCM}, format="json", **office["h_r1"])
    assert PushSubscription.objects.filter(endpoint=FCM).exists()
    api_client.post(f"{PUSH_URL}unsubscribe/", {"endpoint": FCM}, format="json", **office["h_r2"])
    assert not PushSubscription.objects.filter(endpoint=FCM).exists()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/x",  # not https
        "https://127.0.0.1/x",
        "https://internal.example.org/push",
        "https://fcm.googleapis.com.evil.test/x",
        "https://169.254.169.254/latest/meta-data",
    ],
)
def test_subscribe_rejects_non_push_hosts(api_client, office, endpoint):
    r = api_client.post(f"{PUSH_URL}subscribe/", sub_body(endpoint), format="json", **office["h_r1"])
    assert r.status_code == 400
    assert not PushSubscription.objects.exists()


@pytest.mark.django_db
def test_correspondence_push_is_generic(api_client, office, sent, django_capture_on_commit_callbacks):
    payload = b"\x14" + CANARY.encode() + mls_payload(16)
    with django_capture_on_commit_callbacks(execute=True):
        prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]], payload=payload)
    assert len(sent) == 1
    users, body = sent[0]
    assert users == {str(office["r1"].id)}
    assert body["title"] == "وصلتك مراسلة جديدة"
    assert body["url"].startswith("/correspondence/")
    assert CANARY not in json.dumps(body, ensure_ascii=False)


@pytest.mark.django_db
def test_muted_kind_is_not_pushed(api_client, office, sent, django_capture_on_commit_callbacks):
    NotificationPreference.objects.create(user=office["r1"], prefs={"muted_kinds": ["new_correspondence"]})
    with django_capture_on_commit_callbacks(execute=True):
        prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]])
    assert sent == []


@pytest.mark.django_db
def test_chat_message_pushes_other_members_only(api_client, user_factory, sent, django_capture_on_commit_callbacks):
    a, b = user_factory("push_a"), user_factory("push_b")
    h_a = auth(api_client, "push_a")
    conv_id = create_conversation(api_client, h_a, "dm", [b.id]).json()["id"]
    dev_a = make_device(a)
    assert post_message(api_client, h_a, conv_id, "commit", mls_payload(), sender_device_id=dev_a.id).status_code == 201
    assert sent == []  # handshakes are silent
    with django_capture_on_commit_callbacks(execute=True):
        r = post_message(api_client, h_a, conv_id, "application", b"\x14" + CANARY.encode() + mls_payload(16),
                         sender_device_id=dev_a.id)
    assert r.status_code == 201, r.json()
    users, body = sent[0]
    assert users == {str(b.id)}
    assert body["url"] == f"/chat/{conv_id}" and body["tag"] == f"chat:{conv_id}"
    assert CANARY not in json.dumps(body, ensure_ascii=False)


@pytest.mark.django_db
def test_dead_endpoint_is_deleted_and_success_recorded(office, monkeypatch):
    import pywebpush

    sub = PushSubscription.objects.create(user=office["r1"], endpoint=FCM, p256dh="B" * 87, auth="a" * 22)
    monkeypatch.setattr(pywebpush, "webpush", lambda **kw: None)
    push.deliver_one(sub.id, "{}")
    sub.refresh_from_db()
    assert sub.last_success_at is not None

    def gone(**kw):
        raise pywebpush.WebPushException("gone", response=types.SimpleNamespace(status_code=410))

    monkeypatch.setattr(pywebpush, "webpush", gone)
    push.deliver_one(sub.id, "{}")
    assert not PushSubscription.objects.filter(id=sub.id).exists()


@pytest.mark.django_db
def test_test_push_requires_own_subscription(api_client, office, sent, django_capture_on_commit_callbacks):
    assert api_client.post(f"{PUSH_URL}test/", **office["h_r1"]).status_code == 400
    api_client.post(f"{PUSH_URL}subscribe/", sub_body(), format="json", **office["h_r1"])
    with django_capture_on_commit_callbacks(execute=True):
        assert api_client.post(f"{PUSH_URL}test/", **office["h_r1"]).status_code == 200
    assert sent[0][0] == {str(office["r1"].id)}


def test_invalid_vapid_key_disables_push_instead_of_crashing(settings):
    settings.WEB_PUSH_VAPID_PRIVATE_KEY = "CHANGE_ME"
    push._private_key.cache_clear()
    assert push.enabled() is False
    push.push_to_users(["x"], kind="test", title="t")  # no exception
