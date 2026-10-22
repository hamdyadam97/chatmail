"""MFA lifecycle tests: setup → enable → login with OTP → wrong OTP
rejected → audit written. SEC-relevant: audit rows must never contain the
OTP or the TOTP secret."""
import pyotp
import pytest
from django.conf import settings

from apps.accounts.models import User
from apps.audit.models import AuditLog

from .conftest import auth_headers, login

pytestmark = pytest.mark.django_db

SETUP_URL = "/api/v1/auth/mfa/setup/"
ENABLE_URL = "/api/v1/auth/mfa/enable/"
DISABLE_URL = "/api/v1/auth/mfa/disable/"
VERIFY_URL = "/api/v1/auth/mfa/verify/"


def _enable_mfa(client, username, password="Str0ng!Passw0rd"):
    access = login(client, username, password).json()["access"]
    headers = auth_headers(access)
    setup = client.post(SETUP_URL, **headers)
    assert setup.status_code == 200
    secret = setup.json()["secret"]
    otp = pyotp.TOTP(secret).now()
    enable = client.post(ENABLE_URL, {"otp": otp}, format="json", **headers)
    assert enable.status_code == 200
    return secret


def test_mfa_full_flow(api_client, user_factory):
    user_factory("mfa_user")
    secret = _enable_mfa(api_client, "mfa_user")
    user = User.objects.get(username="mfa_user")
    assert user.mfa_enabled is True
    assert user.mfa_method == "totp"
    # ciphertext stored, not the plaintext secret
    assert bytes(user.mfa_secret_ciphertext) != secret.encode()

    # login now requires MFA
    response = login(api_client, "mfa_user")
    assert response.status_code == 200
    body = response.json()
    assert body["mfa_required"] is True
    assert "mfa_token" in body
    assert "access" not in body
    # no refresh cookie issued before MFA completion
    assert settings.AUTH_REFRESH_COOKIE_NAME not in response.cookies

    # wrong OTP rejected
    bad = api_client.post(
        VERIFY_URL, {"mfa_token": body["mfa_token"], "otp": "000000"}, format="json"
    )
    assert bad.status_code == 401
    assert AuditLog.objects.filter(action="mfa_verify_failed").exists()

    # correct OTP completes login, issues session + refresh cookie
    good = api_client.post(
        VERIFY_URL,
        {"mfa_token": body["mfa_token"], "otp": pyotp.TOTP(secret).now()},
        format="json",
    )
    assert good.status_code == 200
    assert good.json()["mfa_required"] is False
    assert good.json()["access"]
    assert settings.AUTH_REFRESH_COOKIE_NAME in good.cookies


def test_mfa_token_is_single_use(api_client, user_factory):
    user_factory("mfa_once")
    secret = _enable_mfa(api_client, "mfa_once")
    challenge = login(api_client, "mfa_once").json()["mfa_token"]
    payload = {"mfa_token": challenge, "otp": pyotp.TOTP(secret).now()}
    assert api_client.post(VERIFY_URL, payload, format="json").status_code == 200
    replay = api_client.post(VERIFY_URL, payload, format="json")
    assert replay.status_code == 401


def test_mfa_disable_requires_valid_otp(api_client, user_factory):
    user_factory("mfa_off")
    secret = _enable_mfa(api_client, "mfa_off")
    # must complete MFA to obtain an authenticated session for disable:
    challenge = login(api_client, "mfa_off").json()["mfa_token"]
    done = api_client.post(
        VERIFY_URL,
        {"mfa_token": challenge, "otp": pyotp.TOTP(secret).now()},
        format="json",
    )
    access = done.json()["access"]

    bad = api_client.post(DISABLE_URL, {"otp": "000000"}, format="json", **auth_headers(access))
    assert bad.status_code == 400
    assert User.objects.get(username="mfa_off").mfa_enabled is True

    good = api_client.post(
        DISABLE_URL, {"otp": pyotp.TOTP(secret).now()}, format="json", **auth_headers(access)
    )
    assert good.status_code == 200
    user = User.objects.get(username="mfa_off")
    assert user.mfa_enabled is False
    assert user.mfa_secret_ciphertext is None
    assert AuditLog.objects.filter(action="mfa_disabled").exists()


def test_audit_never_contains_otp_or_secret(api_client, user_factory):
    user_factory("mfa_audit", password="AuditMe!12345")
    secret = _enable_mfa(api_client, "mfa_audit", password="AuditMe!12345")
    otp = pyotp.TOTP(secret).now()
    challenge = login(api_client, "mfa_audit", "AuditMe!12345").json()["mfa_token"]
    api_client.post(VERIFY_URL, {"mfa_token": challenge, "otp": otp}, format="json")

    forbidden = {otp, secret, "AuditMe!12345"}
    for row in AuditLog.objects.all():
        blob = f"{row.metadata}{row.user_agent}{row.target_type}{row.org_scope}"
        for value in forbidden:
            assert value not in blob, f"secret leaked into audit row {row.action}"
    assert AuditLog.objects.filter(action="mfa_enabled").exists()
    assert AuditLog.objects.filter(action="login").exists()


def test_enable_without_setup_rejected(api_client, user_factory):
    user_factory("no_setup")
    access = login(api_client, "no_setup").json()["access"]
    response = api_client.post(
        ENABLE_URL, {"otp": "123456"}, format="json", **auth_headers(access)
    )
    assert response.status_code == 400
