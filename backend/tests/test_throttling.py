"""Login throttling: per-IP and per-username rate limits.

Rates are pinned via monkeypatch on the throttle classes because DRF
caches THROTTLE_RATES as a class attribute at import time — overriding
REST_FRAMEWORK mid-process leaves that cache stale, so override_settings
is not reliable for throttle rates.
"""
import pyotp
import pytest

from apps.accounts import throttles

from .conftest import auth_headers, login

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _pinned_rates(monkeypatch):
    monkeypatch.setattr(throttles.LoginUsernameThrottle, "rate", "3/hour", raising=False)
    monkeypatch.setattr(throttles.LoginIPThrottle, "rate", "1000/hour", raising=False)
    monkeypatch.setattr(throttles.MFAVerifyIPThrottle, "rate", "5/hour", raising=False)


def test_login_throttled_per_username(api_client, user_factory):
    user_factory("victim")
    for _ in range(3):
        assert login(api_client, "victim", "BadPassw0rd!").status_code == 401
    blocked = login(api_client, "victim", "BadPassw0rd!")
    assert blocked.status_code == 429


def test_login_throttle_is_per_username_not_ip(api_client, user_factory):
    user_factory("u1")
    user_factory("u2")
    # tripping the limit for u1 must not block u2 from the same IP
    for _ in range(3):
        login(api_client, "u1", "Bad")
    assert login(api_client, "u1", "Bad").status_code == 429
    assert login(api_client, "u2", "Bad").status_code == 401


def test_successful_logins_count_toward_username_limit(api_client, user_factory):
    user_factory("busy")
    for _ in range(3):
        assert login(api_client, "busy").status_code == 200
    assert login(api_client, "busy").status_code == 429


def test_mfa_verify_throttled(api_client, user_factory):
    user_factory("mfalimit")
    access = login(api_client, "mfalimit").json()["access"]
    setup = api_client.post("/api/v1/auth/mfa/setup/", **auth_headers(access))
    secret = setup.json()["secret"]
    api_client.post(
        "/api/v1/auth/mfa/enable/",
        {"otp": pyotp.TOTP(secret).now()},
        format="json",
        **auth_headers(access),
    )
    challenge = login(api_client, "mfalimit").json()["mfa_token"]
    statuses = [
        api_client.post(
            "/api/v1/auth/mfa/verify/", {"mfa_token": challenge, "otp": "000000"}, format="json"
        ).status_code
        for _ in range(6)
    ]
    assert 401 in statuses
    assert 429 in statuses
