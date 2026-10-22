"""Authorization engine unit tests: RBAC + scope, positive and negative
branches (doc 07 gate 1)."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.authorization.services import get_user_roles, has_permission
from apps.org.models import Branch, Department

pytestmark = pytest.mark.django_db


@pytest.fixture
def tree(institute_a, institute_b):
    branch1 = Branch.objects.create(institute=institute_a, name="فرع 1", code="T1")
    branch2 = Branch.objects.create(institute=institute_a, name="فرع 2", code="T2")
    dept1 = Department.objects.create(institute=institute_a, branch=branch1, name="قسم 1", code="TD1")
    dept1b = Department.objects.create(institute=institute_a, branch=branch1, name="قسم 2", code="TD2")
    dept_inst = Department.objects.create(institute=institute_a, name="قسم معهد", code="TDI")
    branch_b = Branch.objects.create(institute=institute_b, name="فرع B", code="TB")
    return {
        "inst_a": institute_a, "inst_b": institute_b,
        "branch1": branch1, "branch2": branch2,
        "dept1": dept1, "dept1b": dept1b, "dept_inst": dept_inst, "branch_b": branch_b,
    }


def test_institute_scope_subtree(user_factory, role_factory, tree):
    user = user_factory("inst_scope_user")
    role_factory(user, "institute_manager", institute=tree["inst_a"])
    assert has_permission(user, "org.manage_structure", unit=None) is False
    assert has_permission(user, "org.manage_structure", unit=tree["inst_b"]) is False
    assert has_permission(user, "org.manage_structure", unit=tree["branch_b"]) is False
    assert has_permission(user, "org.manage_structure", unit=tree["inst_a"]) is True
    assert has_permission(user, "org.manage_structure", unit=tree["branch1"]) is True
    assert has_permission(user, "org.manage_structure", unit=tree["dept1"]) is True
    assert has_permission(user, "org.manage_structure", unit=tree["dept_inst"]) is True


def test_central_scope_covers_all_units(user_factory, role_factory, tree):
    user = user_factory("central_user")
    role_factory(user, "sys_admin")  # central: all scope FKs NULL
    assert has_permission(user, "accounts.manage_users", unit=None) is True
    assert has_permission(user, "accounts.manage_users", unit=tree["inst_b"]) is True
    assert has_permission(user, "accounts.manage_users", unit=tree["dept1"]) is True
    # ...but only for permissions the role actually holds
    assert has_permission(user, "roles.manage", unit=None) is False


def test_branch_scope_subtree(user_factory, role_factory, tree):
    user = user_factory("branch_user")
    role_factory(user, "branch_manager", institute=tree["inst_a"], branch=tree["branch1"])
    assert has_permission(user, "org.manage_structure", unit=tree["dept1"]) is True
    assert has_permission(user, "org.manage_structure", unit=tree["dept1b"]) is True
    assert has_permission(user, "org.manage_structure", unit=tree["branch1"]) is True
    assert has_permission(user, "org.manage_structure", unit=tree["branch2"]) is False
    assert has_permission(user, "org.manage_structure", unit=tree["inst_a"]) is False
    assert has_permission(user, "org.manage_structure", unit=tree["inst_b"]) is False


def test_department_scope_exact_only(user_factory, role_factory, tree):
    user = user_factory("dept_user")
    role_factory(user, "dept_head", institute=tree["inst_a"], branch=tree["branch1"],
                 department=tree["dept1"])
    # approvals.act is in dept_head's role; org.manage_structure is NOT
    assert has_permission(user, "approvals.act", unit=tree["dept1"]) is True
    assert has_permission(user, "approvals.act", unit=tree["dept1b"]) is False
    assert has_permission(user, "approvals.act", unit=tree["branch1"]) is False
    assert has_permission(user, "approvals.act", unit=None) is False
    assert has_permission(user, "org.manage_structure", unit=tree["dept1"]) is False


def test_inactive_user_has_nothing(user_factory, role_factory, tree):
    user = user_factory("inactive_user", is_active=False)
    role_factory(user, "sys_admin")
    assert has_permission(user, "accounts.manage_users", unit=None) is False


def test_expired_assignment(user_factory, role_factory, tree):
    user = user_factory("expired_user")
    assignment = role_factory(user, "institute_manager", institute=tree["inst_a"])
    assignment.expires_at = timezone.now() - timedelta(hours=1)
    assignment.save(update_fields=["expires_at"])
    assert has_permission(user, "org.manage_structure", unit=tree["branch1"]) is False


def test_future_expiry_still_valid(user_factory, role_factory, tree):
    from apps.authorization.models import UserRoleAssignment

    user = user_factory("future_user")
    role_factory(user, "institute_manager", institute=tree["inst_a"])
    assignment = UserRoleAssignment.objects.get(user=user)
    assignment.expires_at = timezone.now() + timedelta(days=7)
    assignment.save(update_fields=["expires_at"])
    assert has_permission(user, "org.manage_structure", unit=tree["branch1"]) is True


def test_get_user_roles(user_factory, role_factory):
    user = user_factory("multi_role")
    role_factory(user, "employee")
    role_factory(user, "archive_officer")
    codes = {r.code for r in get_user_roles(user)}
    assert codes == {"employee", "archive_officer"}


def test_no_assignment_no_permission(user_factory, tree):
    user = user_factory("lonely_user")
    assert has_permission(user, "correspondence.send", unit=None) is False
    assert has_permission(user, "correspondence.send", unit=tree["inst_a"]) is False
