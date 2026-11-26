"""The mobile app (React Native): no cookies — it sends `X-Corr-Client: app`,
gets the refresh and device tokens in the body, keeps them in secure storage
and sends them back. Same sessions, same new-device code, same rules.
Its push token (Expo) gets the same fixed titles as browser push."""
import pytest
from rest_framework.test import APIClient

from apps.accounts import login_approval
from apps.accounts.models import LoginApproval, TrustedDevice, UserSession
from apps.notifications import push
from apps.notifications.models import AppPushToken

from .conftest import DEFAULT_PASSWORD, auth_headers

pytestmark = pytest.mark.django_db
AUTH = "/api/v1/auth/"
APP = {"HTTP_X_CORR_CLIENT": "app", "HTTP_USER_AGENT": "CorrApp/1.0 (Android 14)"}


def _login(client, username, device=None):
    extra = dict(APP, **({"HTTP_X_CORR_DEVICE": device} if device else {}))
    return client.post(f"{AUTH}login/", {"username": username, "password": DEFAULT_PASSWORD}, format="json", **extra)


def test_app_gets_tokens_in_the_body_and_no_cookies(user_factory):
    user_factory("app_u")
    r = _login(APIClient(), "app_u")
    body = r.json()
    assert r.status_code == 200 and body["access"] and body["refresh"] and body["device_token"]
    assert not r.cookies  # nothing in a cookie jar
    device = TrustedDevice.objects.get(user__username="app_u")
    assert device.device_label.startswith("التطبيق") and device.platform == "android"

    # refresh with the body token rotates it
    r2 = APIClient().post(f"{AUTH}refresh/", {"refresh": body["refresh"]}, format="json", **APP)
    assert r2.status_code == 200 and r2.json()["refresh"] != body["refresh"] and r2.json()["access"]
    assert not r2.cookies
    # the browser path never reads a body token
    assert APIClient().post(f"{AUTH}refresh/", {"refresh": r2.json()["refresh"]}, format="json").status_code == 401

    out = APIClient().post(f"{AUTH}logout/", {"refresh": r2.json()["refresh"]}, format="json", **APP)
    assert out.status_code == 204
    assert not UserSession.objects.filter(user__username="app_u", revoked_at__isnull=True).exists()


def test_app_device_token_skips_the_new_device_code(user_factory, settings):
    settings.LOGIN_NEW_DEVICE_APPROVAL = True
    user_factory("app_v")
    first = _login(APIClient(), "app_v").json()
    assert first["approval_required"]
    approval = LoginApproval.objects.get(user__username="app_v")
    ok = APIClient().post(f"{AUTH}login/code/", {"approval_token": first["approval_token"],
                                                 "code": login_approval.code_of(approval)}, format="json", **APP)
    device_token = ok.json()["device_token"]
    assert ok.status_code == 200 and device_token and ok.json()["refresh"]
    # the same phone later: straight in; a wrong or missing token: a code again
    assert "access" in _login(APIClient(), "app_v", device=device_token).json()
    assert _login(APIClient(), "app_v", device="nope").json()["approval_required"]
    assert _login(APIClient(), "app_v").json()["approval_required"]


def test_app_push_token_register_move_and_unregister(user_factory):
    a, b = user_factory("app_a"), user_factory("app_b")
    token = "ExponentPushToken[abcDEF1234567890xyz]"
    ca, cb = APIClient(), APIClient()
    ca.credentials(**auth_headers_for(ca, "app_a"))
    cb.credentials(**auth_headers_for(cb, "app_b"))
    url = "/api/v1/notifications/push/app/register/"
    assert ca.post(url, {"token": "http://evil.example/x"}, format="json").status_code == 400
    assert ca.post(url, {"token": token, "platform": "android"}, format="json").status_code == 204
    assert AppPushToken.objects.get(token=token).user == a
    # same phone, other account: the token moves
    assert cb.post(url, {"token": token, "platform": "android"}, format="json").status_code == 204
    assert AppPushToken.objects.get(token=token).user == b
    # only the owner can remove it
    ca.post("/api/v1/notifications/push/app/unregister/", {"token": token}, format="json")
    assert AppPushToken.objects.filter(token=token).exists()
    cb.post("/api/v1/notifications/push/app/unregister/", {"token": token}, format="json")
    assert not AppPushToken.objects.filter(token=token).exists()


def auth_headers_for(client, username):
    r = _login(client, username)
    return auth_headers(r.json()["access"])


def test_app_delivery_sends_fixed_titles_and_drops_dead_tokens(user_factory, monkeypatch):
    u = user_factory("app_p")
    live = AppPushToken.objects.create(user=u, token="ExponentPushToken[live1234567890ab]")
    dead = AppPushToken.objects.create(user=u, token="ExponentPushToken[dead1234567890ab]")
    sent = []

    class Resp:
        def json(self):
            return {"data": [{"status": "ok"}, {"status": "error", "details": {"error": "DeviceNotRegistered"}}]}

    monkeypatch.setattr("requests.post", lambda url, **kw: sent.append((url, kw["json"])) or Resp())
    push.app_deliver([live.token, dead.token], {"title": "مراسلة جديدة", "body": "من أحمد", "url": "/mail/inbox/1"})
    url, body = sent[0]
    assert url == push.EXPO_PUSH_URL
    assert body[0]["title"] == "مراسلة جديدة" and body[0]["data"] == {"url": "/mail/inbox/1"}
    assert set(body[0]) == {"to", "title", "body", "data", "sound", "channelId", "priority", "ttl"}
    live.refresh_from_db()
    assert live.last_success_at is not None
    assert not AppPushToken.objects.filter(pk=dead.pk).exists()


def test_app_version_is_public_and_only_https(api_client, settings):
    settings.APP_ANDROID_LATEST, settings.APP_ANDROID_URL = "", ""
    assert api_client.get("/api/v1/auth/app-version/").json() == {"android": None}
    settings.APP_ANDROID_LATEST, settings.APP_ANDROID_URL = "5.1.0", "http://plain.example/app.apk"
    assert api_client.get("/api/v1/auth/app-version/").json() == {"android": None}  # never a plain-http download
    settings.APP_ANDROID_URL = "https://mail.example/app.apk"
    assert api_client.get("/api/v1/auth/app-version/").json() == {"android": {"version": "5.1.0", "url": "https://mail.example/app.apk"}}
