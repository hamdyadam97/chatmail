"""Concurrent refresh race (two tabs / React StrictMode double boot).

The loser of the race presents a token rotated moments ago. It must get a
recognisable 401 WITHOUT a cookie-clearing Set-Cookie, so the winner's fresh
cookie survives in the browser. An old token outside the grace window is
still refused and its cookie cleared.
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


def test_loser_of_refresh_race_keeps_the_winners_cookie(api_client, user_factory):
    user_factory("race_user")
    login(api_client, "race_user")
    old = api_client.cookies[COOKIE].value

    first = api_client.post(REFRESH)
    assert first.status_code == 200
    new = first.cookies[COOKIE].value
    assert new and new != old

    # second request of the race, still carrying the old cookie
    api_client.cookies[COOKIE] = old
    second = api_client.post(REFRESH)
    assert second.status_code == 401
    assert second.json()["code"] == "refresh_superseded"
    assert COOKIE not in second.cookies  # no deletion of the newer cookie

    # the winner's cookie works
    api_client.cookies[COOKIE] = new
    assert api_client.post(REFRESH).status_code == 200


def test_old_token_outside_grace_is_refused_and_cleared(api_client, user_factory):
    user_factory("race_old")
    login(api_client, "race_old")
    old = api_client.cookies[COOKIE].value
    assert api_client.post(REFRESH).status_code == 200
    UserSession.objects.filter(revoked_reason="rotated").update(revoked_at=timezone.now() - timedelta(minutes=5))
    api_client.cookies[COOKIE] = old
    resp = api_client.post(REFRESH)
    assert resp.status_code == 401
    assert resp.json().get("code") != "refresh_superseded"
    assert resp.cookies[COOKIE].value == ""  # cleared


def test_logged_out_token_is_not_treated_as_a_race(api_client, user_factory):
    user_factory("race_logout")
    login(api_client, "race_logout")
    token = api_client.cookies[COOKIE].value
    api_client.post("/api/v1/auth/logout/")
    api_client.cookies[COOKIE] = token
    resp = api_client.post(REFRESH)
    assert resp.status_code == 401 and resp.json().get("code") != "refresh_superseded"
