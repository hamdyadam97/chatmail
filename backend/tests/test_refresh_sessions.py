"""Refresh rotation, logout revocation, session listing/revocation tests."""
import pytest
from django.conf import settings
from rest_framework.test import APIClient

from apps.accounts.models import UserSession

from .conftest import auth_headers, login

pytestmark = pytest.mark.django_db

REFRESH_URL = "/api/v1/auth/refresh/"
LOGOUT_URL = "/api/v1/auth/logout/"
SESSIONS_URL = "/api/v1/auth/sessions/"
COOKIE = settings.AUTH_REFRESH_COOKIE_NAME


def _refresh_cookie_value(response):
    return response.cookies[COOKIE].value


def test_refresh_rotates_token_and_rejects_old_one(api_client, user_factory):
    user_factory("rotator")
    login_resp = login(api_client, "rotator")
    old_token = _refresh_cookie_value(login_resp)

    first = api_client.post(REFRESH_URL)
    assert first.status_code == 200
    assert first.json()["access"]
    new_token = _refresh_cookie_value(first)
    assert new_token != old_token

    # the old refresh token is revoked: replaying it fails (no new session).
    # Within the rotation grace window the cookie is NOT cleared — the browser
    # already holds the newer one (see test_refresh_race.py, which also covers
    # the cleared case outside the window).
    api_client.cookies[COOKIE] = old_token
    replay = api_client.post(REFRESH_URL)
    assert replay.status_code == 401
    assert "access" not in replay.json()

    # the rotated token works
    api_client.cookies[COOKIE] = new_token
    second = api_client.post(REFRESH_URL)
    assert second.status_code == 200
    assert _refresh_cookie_value(second) != new_token


def test_refresh_without_cookie_rejected(api_client):
    response = api_client.post(REFRESH_URL)
    assert response.status_code == 401


def test_logout_revokes_session(api_client, user_factory):
    user_factory("leaver")
    login(api_client, "leaver")
    assert api_client.post(LOGOUT_URL).status_code == 204
    follow = api_client.post(REFRESH_URL)
    assert follow.status_code == 401


def test_sessions_list_marks_current_and_revoke_others(api_client, user_factory):
    user = user_factory("multi")
    login(api_client, "multi")
    other_client = APIClient()
    login(other_client, "multi")

    access = login(api_client, "multi").json()["access"]
    response = api_client.get(SESSIONS_URL, **auth_headers(access))
    assert response.status_code == 200
    sessions = response.json()
    assert len(sessions) == 3
    assert sum(1 for s in sessions if s["current"]) == 1
    current = next(s for s in sessions if s["current"])
    other = next(s for s in sessions if not s["current"])

    revoke = api_client.delete(f"{SESSIONS_URL}{other['id']}/", **auth_headers(access))
    assert revoke.status_code == 204
    assert UserSession.objects.get(id=other["id"]).revoked_at is not None
    assert UserSession.objects.get(id=current["id"]).revoked_at is None


def test_cannot_revoke_another_users_session(api_client, user_factory):
    user_factory("owner")
    user_factory("intruder")
    login_owner = login(api_client, "owner")
    access = login_owner.json()["access"]
    victim = next(
        s for s in api_client.get(SESSIONS_URL, **auth_headers(access)).json()
    )
    # intruder cannot see it in their own list, and DELETE by id is rejected
    intruder_client = APIClient()
    login(intruder_client, "intruder")
    intruder_access = login(intruder_client, "intruder").json()["access"]
    response = intruder_client.delete(
        f"{SESSIONS_URL}{victim['id']}/", **auth_headers(intruder_access)
    )
    assert response.status_code == 403
    assert UserSession.objects.get(id=victim["id"]).revoked_at is None
