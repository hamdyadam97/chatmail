"""Refresh reuse interval: a rotation whose response never reached the browser.

Real cases: the page is reloaded/closed while the boot refresh is in flight,
two tabs refresh at once, a connection drops. The server has rotated, the
cookie jar still holds the old token. Within ROTATION_GRACE_SECONDS the old
token gets the live successor rotated (user stays signed in); outside it, or
once the chain was ended by logout/revocation, it is refused as before.
"""
from datetime import timedelta

import pytest
from django.conf import settings
from django.utils import timezone

from apps.accounts.models import UserSession

from .conftest import login

pytestmark = pytest.mark.django_db

REFRESH = "/api/v1/auth/refresh/"
COOKIE = settings.AUTH_REFRESH_COOKIE_NAME


def _signed_in(api_client, username):
    login(api_client, username)
    return api_client.cookies[COOKIE].value


def test_lost_rotation_response_recovers_within_grace(api_client, user_factory):
    user_factory("race_user")
    old = _signed_in(api_client, "race_user")
    first = api_client.post(REFRESH)
    assert first.status_code == 200
    lost = first.cookies[COOKIE].value  # pretend this response never arrived

    api_client.cookies[COOKIE] = old
    again = api_client.post(REFRESH)
    assert again.status_code == 200 and again.json()["access"]
    fresh = again.cookies[COOKIE].value
    assert fresh not in (old, lost)
    # exactly one live session remains — no branching
    assert UserSession.objects.filter(user__username="race_user", revoked_at__isnull=True).count() == 1
    # the newest cookie keeps working; the lost one is now rotated away
    api_client.cookies[COOKIE] = fresh
    assert api_client.post(REFRESH).status_code == 200


def test_chain_of_lost_responses_is_followed(api_client, user_factory):
    user_factory("race_chain")
    old = _signed_in(api_client, "race_chain")
    api_client.post(REFRESH)            # old -> s1 (lost)
    api_client.post(REFRESH)            # s1 -> s2 (lost)
    api_client.cookies[COOKIE] = old
    assert api_client.post(REFRESH).status_code == 200
    assert UserSession.objects.filter(user__username="race_chain", revoked_at__isnull=True).count() == 1


def test_old_token_outside_grace_is_refused_and_cleared(api_client, user_factory):
    user_factory("race_old")
    old = _signed_in(api_client, "race_old")
    assert api_client.post(REFRESH).status_code == 200
    UserSession.objects.filter(revoked_reason="rotated").update(revoked_at=timezone.now() - timedelta(minutes=5))
    api_client.cookies[COOKIE] = old
    resp = api_client.post(REFRESH)
    assert resp.status_code == 401
    assert resp.cookies[COOKIE].value == ""  # cleared


def test_logout_ends_the_chain(api_client, user_factory):
    user_factory("race_logout")
    old = _signed_in(api_client, "race_logout")
    assert api_client.post(REFRESH).status_code == 200   # old -> s1
    api_client.post("/api/v1/auth/logout/")              # s1 logged out
    api_client.cookies[COOKIE] = old
    assert api_client.post(REFRESH).status_code == 401
    assert not UserSession.objects.filter(user__username="race_logout", revoked_at__isnull=True).exists()


def test_admin_revocation_ends_the_chain(api_client, user_factory):
    from apps.accounts.api.services import revoke_all_user_sessions

    user = user_factory("race_revoked")
    old = _signed_in(api_client, "race_revoked")
    assert api_client.post(REFRESH).status_code == 200
    revoke_all_user_sessions(user, reason="admin_revoked")
    api_client.cookies[COOKIE] = old
    assert api_client.post(REFRESH).status_code == 401
