"""Role assignment management tests (roles.manage, central-only) +
audit of grants/revokes."""
import pytest

from apps.audit.models import AuditLog
from apps.authorization.models import UserRoleAssignment

from .conftest import auth_headers, login

pytestmark = pytest.mark.django_db

ASSIGN_URL = "/api/v1/roles/assignments/"


def _access(client, username):
    return login(client, username).json()["access"]


def test_hr_admin_grants_and_revokes_centrally(api_client, user_factory, role_factory, institute_a):
    hr = user_factory("hr1")
    role_factory(hr, "hr_admin")  # central by default
    target = user_factory("grantee", membership_unit=institute_a)
    access = _access(api_client, "hr1")

    response = api_client.post(
        ASSIGN_URL,
        {"user_id": str(target.id), "role_code": "employee", "institute_id": str(institute_a.id)},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 201
    assignment = UserRoleAssignment.objects.get(user=target)
    assert assignment.role.code == "employee"
    granted = AuditLog.objects.get(action="permission_granted")
    assert granted.metadata["user"] == "grantee"
    assert granted.metadata["role"] == "employee"

    revoke = api_client.delete(
        f"{ASSIGN_URL}{assignment.id}/", **auth_headers(access)
    )
    assert revoke.status_code == 204
    assert not UserRoleAssignment.objects.filter(id=assignment.id).exists()
    assert AuditLog.objects.filter(action="permission_revoked").exists()


def test_assignment_scope_consistency_enforced(api_client, user_factory, role_factory,
                                               institute_a, branch_b):
    hr = user_factory("hr2")
    role_factory(hr, "hr_admin")
    target = user_factory("grantee2")
    access = _access(api_client, "hr2")
    response = api_client.post(
        ASSIGN_URL,
        {"user_id": str(target.id), "role_code": "employee",
         "institute_id": str(institute_a.id), "branch_id": str(branch_b.id)},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 400


def test_sys_admin_has_no_roles_manage_separation_of_duties(api_client, user_factory, role_factory):
    """§5.5 duty separation: accounts.manage_users holder must NOT manage roles."""
    admin = user_factory("sysadmin5")
    role_factory(admin, "sys_admin")
    target = user_factory("grantee3")
    access = _access(api_client, "sysadmin5")
    response = api_client.post(
        ASSIGN_URL,
        {"user_id": str(target.id), "role_code": "employee"},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 403
    assert AuditLog.objects.filter(action="unauthorized_access_denied").exists()


def test_scoped_roles_manage_grants_nothing(api_client, user_factory, role_factory, institute_a):
    """roles.manage is central-only: an institute-scoped assignment must not work."""
    fake_hr = user_factory("hr3", membership_unit=institute_a)
    role_factory(fake_hr, "hr_admin", institute=institute_a)
    target = user_factory("grantee4")
    access = _access(api_client, "hr3")
    response = api_client.post(
        ASSIGN_URL,
        {"user_id": str(target.id), "role_code": "employee"},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 403


def test_expired_assignment_stops_working(api_client, user_factory, role_factory, institute_a):
    from datetime import timedelta

    from django.utils import timezone

    hr = user_factory("hr4")
    role_factory(hr, "hr_admin")
    target = user_factory("grantee5")
    access = _access(api_client, "hr4")
    past = timezone.now() - timedelta(days=1)
    response = api_client.post(
        ASSIGN_URL,
        {"user_id": str(target.id), "role_code": "employee",
         "expires_at": past.isoformat()},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 201
    # the brand-new assignment is already expired: directory write denied for... hr still
    # central (own assignment unaffected). Instead check engine directly:
    from apps.authorization.services import has_permission

    assert has_permission(target, "correspondence.send", unit=institute_a) is False
