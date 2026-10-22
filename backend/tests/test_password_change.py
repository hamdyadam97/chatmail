"""Password change policy: Argon2 policy enforcement and session revocation."""
import pytest

from apps.accounts.models import UserSession
from apps.audit.models import AuditLog

from .conftest import DEFAULT_PASSWORD, auth_headers, login

pytestmark = pytest.mark.django_db

CHANGE_URL = "/api/v1/auth/password/change/"


def _login_access(client, username, password=DEFAULT_PASSWORD):
    return login(client, username, password).json()["access"]


def test_password_change_revokes_other_sessions_only(api_client, user_factory):
    from rest_framework.test import APIClient

    user_factory("changer")
    api_client.post("/api/v1/auth/logout/")  # no-op safety
    login(api_client, "changer")
    other = APIClient()
    login(other, "changer")
    current_access = _login_access(api_client, "changer")

    response = api_client.post(
        CHANGE_URL,
        {"old_password": DEFAULT_PASSWORD, "new_password": "NewPassw0rd!9"},
        format="json",
        **auth_headers(current_access),
    )
    assert response.status_code == 200
    assert UserSession.objects.filter(revoked_at__isnull=False).count() == 2  # two older sessions
    # current session still valid
    assert api_client.get("/api/v1/users/me/", **auth_headers(current_access)).status_code == 200
    # old password rejected afterwards
    replay = login(APIClient(), "changer", DEFAULT_PASSWORD)
    assert replay.status_code == 401
    assert login(APIClient(), "changer", "NewPassw0rd!9").status_code == 200
    assert AuditLog.objects.filter(action="password_changed").exists()


def test_password_policy_min_length(api_client, user_factory):
    user_factory("shorty")
    access = _login_access(api_client, "shorty")
    response = api_client.post(
        CHANGE_URL,
        {"old_password": DEFAULT_PASSWORD, "new_password": "short"},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 400


def test_password_policy_not_username_derived(api_client, user_factory):
    user_factory("ahmed1979")
    access = _login_access(api_client, "ahmed1979")
    response = api_client.post(
        CHANGE_URL,
        {"old_password": DEFAULT_PASSWORD, "new_password": "ahmed1979_password"},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 400


def test_password_change_requires_old_password(api_client, user_factory):
    user_factory("oldcheck")
    access = _login_access(api_client, "oldcheck")
    response = api_client.post(
        CHANGE_URL,
        {"old_password": "NopeNope!12", "new_password": "FinePassw0rd!"},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 400


def test_changed_password_is_argon2id(api_client, user_factory):
    user = user_factory("hasher")
    access = _login_access(api_client, "hasher")
    api_client.post(
        CHANGE_URL,
        {"old_password": DEFAULT_PASSWORD, "new_password": "FinePassw0rd!"},
        format="json",
        **auth_headers(access),
    )
    user.refresh_from_db()
    # Django encodes Argon2id as "argon2$argon2id$v=19$m=...,t=...,p=8$..."
    assert "argon2id$v=" in user.password
