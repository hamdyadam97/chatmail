"""Core auth contract tests: login success/failure shape and audit."""
import pytest
from django.conf import settings

from apps.audit.models import AuditLog

from .conftest import auth_headers, login

pytestmark = pytest.mark.django_db

LOGIN_URL = "/api/v1/auth/login/"


def test_login_success_issues_access_and_refresh_cookie(api_client, user_factory):
    user_factory("employee1")
    response = login(api_client, "employee1")
    assert response.status_code == 200
    body = response.json()
    assert body["mfa_required"] is False
    assert body["access"]
    assert body["user"]["username"] == "employee1"
    assert body["user"]["full_name"] == "مستخدم employee1"
    assert body["user"]["must_change_password"] is False
    assert set(body["user"].keys()) == {"id", "username", "full_name", "must_change_password"}
    cookie = response.cookies.get(settings.AUTH_REFRESH_COOKIE_NAME)
    assert cookie is not None
    # SimpleCookie flags: httponly/samesite present; path must be exact
    assert cookie["httponly"] in ("", True)
    assert cookie["samesite"] == "Strict"
    assert cookie["path"] == "/api/v1/auth/"


def test_login_failure_is_generic_and_audited_with_no_actor(api_client, user_factory):
    user_factory("employee2")
    response = login(api_client, "employee2", password="WrongPassw0rd")
    assert response.status_code == 401
    log = AuditLog.objects.get(action="login_failed")
    assert log.actor is None  # identity NOT proven -> actor stays NULL
    assert str(log.target_id) != ""
    # the attempted password must never appear anywhere in the audit row
    row_text = f"{log.metadata}{log.user_agent}{log.action}{log.target_type}"
    assert "WrongPassw0rd" not in row_text


def test_login_unknown_user_audited(api_client):
    response = login(api_client, "ghost")
    assert response.status_code == 401
    log = AuditLog.objects.get(action="login_failed")
    assert log.actor is None
    assert log.target_id is None


def test_inactive_user_cannot_login(api_client, user_factory):
    user_factory("fired", is_active=False)
    response = login(api_client, "fired")
    assert response.status_code == 401


def test_me_endpoint_requires_auth(api_client):
    assert api_client.get("/api/v1/users/me/").status_code in (401, 403)


def test_me_returns_basic_profile_and_roles(api_client, user_factory, role_factory, institute_a):
    user = user_factory("employee3", membership_unit=institute_a)
    role_factory(user, "employee", institute=institute_a)
    access = login(api_client, "employee3").json()["access"]
    response = api_client.get("/api/v1/users/me/", **auth_headers(access))
    assert response.status_code == 200
    body = response.json()
    assert body["username"] == "employee3"
    assert body["roles"][0]["role"] == "employee"
    assert "password" not in body and "mfa_secret" not in body
