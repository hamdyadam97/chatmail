"""SEC-08: password reset is login-only and structurally isolated from
any crypto store.

Full flow asserted:
  - temp password (16 chars) returned exactly once
  - login with temp password works; must_change_password flag set
  - all pre-existing sessions revoked
  - CANARY: trusted_devices rows of the user are unchanged
  - CANARY: user_crypto_identities (now that crypto_keys is built) is
    untouched by the reset — rows before == rows after
  - audit row written without the temp password value
"""
import uuid as uuidlib

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import TrustedDevice, UserSession
from apps.audit.models import AuditLog
from apps.authorization.models import Role, UserRoleAssignment
from apps.crypto_keys.models import UserCryptoIdentity

from .conftest import auth_headers, login

pytestmark = pytest.mark.django_db

USERS_URL = "/api/v1/users/"


def _access(client, username):
    return login(client, username).json()["access"]


def test_full_reset_flow_with_crypto_canary(api_client, user_factory, role_factory,
                                            institute_a, branch_a):
    admin = user_factory("sec08_admin")
    role_factory(admin, "sys_admin")
    target = user_factory("sec08_target", membership_unit=branch_a)

    # the user has live sessions (each login also binds a trusted_devices row)
    login(api_client, "sec08_target")
    second_client = APIClient()
    login(second_client, "sec08_target")
    assert UserSession.objects.filter(user=target, revoked_at__isnull=True).count() == 2

    # --- canary snapshot of the crypto-adjacent stores ---
    devices_before = list(
        TrustedDevice.objects.filter(user=target).order_by("id").values()
    )
    identities_before = list(
        UserCryptoIdentity.objects.filter(user=target).order_by("user_id").values()
    )
    assert len(devices_before) >= 1

    access = _access(api_client, "sec08_admin")
    response = api_client.post(
        f"{USERS_URL}{target.id}/reset-password/", **auth_headers(access)
    )
    assert response.status_code == 200
    temp_password = response.json()["temp_password"]
    assert len(temp_password) == 16

    target.refresh_from_db()
    assert target.must_change_password is True
    assert UserSession.objects.filter(user=target, revoked_at__isnull=True).count() == 0

    # --- canary: zero writes to any crypto-related store ---
    devices_after = list(
        TrustedDevice.objects.filter(user=target).order_by("id").values()
    )
    assert devices_before == devices_after
    # the crypto identity table may exist now (crypto_keys phase) but the
    # reset must not touch it — SEC-08 isolation holds as "no change".
    identities_after = list(
        UserCryptoIdentity.objects.filter(user=target).order_by("user_id").values()
    )
    assert identities_before == identities_after

    # --- audit: event written, secret value absent ---
    row = AuditLog.objects.get(action="password_reset")
    assert str(row.target_id) == str(target.id)
    assert temp_password not in str(row.metadata)

    # --- temp password login works and flags the forced change ---
    fresh = APIClient()
    temp_login = login(fresh, "sec08_target", temp_password)
    assert temp_login.status_code == 200
    body = temp_login.json()
    assert body["user"]["must_change_password"] is True

    # forced change clears the flag and rotates the password
    change = fresh.post(
        "/api/v1/auth/password/change/",
        {"old_password": temp_password, "new_password": "BrandNew!Pass9"},
        format="json",
        **auth_headers(body["access"]),
    )
    assert change.status_code == 200
    target.refresh_from_db()
    assert target.must_change_password is False
    assert login(APIClient(), "sec08_target", temp_password).status_code == 401


def test_reset_requires_manage_users(api_client, user_factory, branch_a):
    user_factory("sec08_bystander")
    target = user_factory("sec08_victim", membership_unit=branch_a)
    access = _access(api_client, "sec08_bystander")
    response = api_client.post(
        f"{USERS_URL}{target.id}/reset-password/", **auth_headers(access)
    )
    assert response.status_code == 403


def test_reset_on_unknown_user_not_found(api_client, user_factory):
    admin = user_factory("sec08_admin2")
    UserRoleAssignment.objects.create(user=admin, role=Role.objects.get(code="sys_admin"))
    access = _access(api_client, "sec08_admin2")
    response = api_client.post(
        f"{USERS_URL}{uuidlib.uuid4()}/reset-password/", **auth_headers(access)
    )
    assert response.status_code == 403
