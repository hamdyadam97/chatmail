"""Role assignment (roles.manage, central-only — held by the admin) and the
five assignable roles with their scopes (user decision 2026-11-08):
employee @institute, branch_manager @one branch, regional_manager @chosen
branches, executive and sys_admin central."""
import pytest

from apps.audit.models import AuditLog
from apps.authorization.models import UserRoleAssignment

from .conftest import auth_headers, login

pytestmark = pytest.mark.django_db

ASSIGN_URL = "/api/v1/roles/assignments/"


def _access(client, username):
    return login(client, username).json()["access"]


@pytest.fixture
def admin_h(api_client, user_factory, role_factory):
    admin = user_factory("roles_admin")
    role_factory(admin, "sys_admin")  # central
    return auth_headers(_access(api_client, "roles_admin"))


def _assign(api_client, h, **body):
    return api_client.post(ASSIGN_URL, {k: (str(v) if not isinstance(v, list) else [str(x) for x in v])
                                        for k, v in body.items()}, format="json", **h)


def test_admin_grants_and_revokes_centrally(api_client, user_factory, admin_h, institute_a):
    target = user_factory("grantee", membership_unit=institute_a)
    response = _assign(api_client, admin_h, user_id=target.id, role_code="employee", institute_id=institute_a.id)
    assert response.status_code == 201
    assignment = UserRoleAssignment.objects.get(user=target)
    assert assignment.role.code == "employee"
    granted = AuditLog.objects.get(action="permission_granted")
    assert granted.metadata["user"] == "grantee" and granted.metadata["role"] == "employee"
    # the same grant again is refused, not duplicated
    assert _assign(api_client, admin_h, user_id=target.id, role_code="employee",
                   institute_id=institute_a.id).status_code == 400

    revoke = api_client.delete(f"{ASSIGN_URL}{assignment.id}/", **admin_h)
    assert revoke.status_code == 204
    assert not UserRoleAssignment.objects.filter(id=assignment.id).exists()
    assert AuditLog.objects.filter(action="permission_revoked").exists()


def test_each_role_takes_its_own_scope(api_client, user_factory, admin_h, institute_a, branch_a, branch_b):
    u = user_factory("scoped_u")
    bad = [
        {"role_code": "employee"},                                              # needs an institute
        {"role_code": "branch_manager", "institute_id": institute_a.id},        # needs a branch
        {"role_code": "branch_manager", "branch_ids": [branch_a.id, branch_b.id]},  # exactly one
        {"role_code": "executive", "branch_id": branch_a.id},                   # central only
        {"role_code": "sys_admin", "institute_id": institute_a.id},             # central only
        {"role_code": "employee", "institute_id": institute_a.id, "branch_id": branch_b.id},  # inconsistent
    ]
    for body in bad:
        assert _assign(api_client, admin_h, user_id=u.id, **body).status_code == 400, body
    # a branch implies its institute
    ok = _assign(api_client, admin_h, user_id=u.id, role_code="branch_manager", branch_id=branch_a.id)
    assert ok.status_code == 201 and ok.json()["institute"] == str(branch_a.institute_id)
    assert _assign(api_client, admin_h, user_id=u.id, role_code="executive").status_code == 201


def test_regional_manager_gets_one_assignment_per_chosen_branch(api_client, user_factory, admin_h,
                                                                branch_a, branch_a2, branch_b):
    from apps.authorization.services import has_permission

    rm = user_factory("regional")
    resp = _assign(api_client, admin_h, user_id=rm.id, role_code="regional_manager",
                   branch_ids=[branch_a.id, branch_b.id])
    assert resp.status_code == 201 and len(resp.json()) == 2
    assert {a.branch_id for a in UserRoleAssignment.objects.filter(user=rm)} == {branch_a.id, branch_b.id}
    assert has_permission(rm, "announcements.publish", unit=branch_b)
    assert not has_permission(rm, "announcements.publish", unit=branch_a2)
    assert not has_permission(rm, "org.manage_structure", unit=branch_a)  # announcements + reports only
    # adding a branch later keeps the existing ones
    assert _assign(api_client, admin_h, user_id=rm.id, role_code="regional_manager",
                   branch_ids=[branch_a.id, branch_a2.id]).status_code == 201
    assert UserRoleAssignment.objects.filter(user=rm).count() == 3


def test_legacy_roles_are_not_assignable_and_catalog_shows_the_five(api_client, user_factory, role_factory,
                                                                     admin_h, institute_a):
    u = user_factory("legacy_u")
    for code in ("hr_admin", "dept_head", "institute_manager", "security_auditor", "archive_officer"):
        assert _assign(api_client, admin_h, user_id=u.id, role_code=code).status_code == 400
    catalog = api_client.get("/api/v1/roles/catalog/", **admin_h).json()
    assert [r["code"] for r in catalog if r["assignable"]] == [
        "employee", "branch_manager", "regional_manager", "executive", "sys_admin"]
    assert not [r for r in catalog if not r["assignable"]]
    # a legacy role still held shows up (transparency) but stays unassignable
    role_factory(u, "dept_head", institute=institute_a)
    legacy = [r for r in api_client.get("/api/v1/roles/catalog/", **admin_h).json() if not r["assignable"]]
    assert [(r["code"], r["holders"]) for r in legacy] == [("dept_head", 1)]


def test_non_admins_cannot_assign(api_client, user_factory, role_factory, institute_a, branch_a):
    for name, role, scope in (("emp_x", "employee", {"institute": institute_a}),
                              ("bm_x", "branch_manager", {"institute": institute_a, "branch": branch_a}),
                              ("exe_x", "executive", {}),
                              ("scoped_adm", "sys_admin", {"institute": institute_a})):  # roles.manage is central-only
        user = user_factory(name, membership_unit=institute_a)
        role_factory(user, role, **scope)
        resp = _assign(api_client, auth_headers(_access(api_client, name)), user_id=user.id,
                       role_code="executive")
        assert resp.status_code == 403, name
    assert AuditLog.objects.filter(action="unauthorized_access_denied").exists()


def test_expired_assignment_stops_working(api_client, user_factory, admin_h, institute_a):
    from datetime import timedelta

    from django.utils import timezone

    from apps.authorization.services import has_permission

    target = user_factory("grantee5")
    past = timezone.now() - timedelta(days=1)
    response = _assign(api_client, admin_h, user_id=target.id, role_code="employee",
                       institute_id=institute_a.id, expires_at=past.isoformat())
    assert response.status_code == 201
    assert has_permission(target, "correspondence.send", unit=institute_a) is False
