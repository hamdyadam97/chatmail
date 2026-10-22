"""seed_demo management command: demo identities for the scripted e2e chat test."""
import pytest
from django.core.management import call_command

from apps.accounts.models import User
from apps.authorization.models import UserRoleAssignment
from apps.org.models import Branch, EmployeeMembership, Institute

pytestmark = pytest.mark.django_db

EXPECTED = {
    "ahmed": "Ahmed@12345",
    "mohamed": "Mohamed@12345",
    "sara": "Sara@12345",
    "admin": "Admin@12345",
    "manager": "Manager@12345",
}


def test_seed_demo_creates_users_with_working_passwords():
    call_command("seed_demo")
    for username, password in EXPECTED.items():
        user = User.objects.get(username=username)
        assert user.is_active
        assert not user.must_change_password
        assert user.check_password(password), username
        assert user.full_name
        assert not user.mfa_enabled  # scripted login must be direct


def test_seed_demo_memberships_and_admin_role():
    call_command("seed_demo")
    ahl = Institute.objects.get(code="AHL")
    ryd = Branch.objects.get(institute=ahl, code="RYD")

    for username in EXPECTED:
        user = User.objects.get(username=username)
        primaries = user.memberships.filter(is_primary=True)
        assert primaries.count() == 1, username
        membership = primaries.first()
        assert membership.institute == ahl
        assert membership.branch == ryd

    admin = User.objects.get(username="admin")
    assert UserRoleAssignment.objects.filter(user=admin, role__code="sys_admin").count() == 1
    manager = User.objects.get(username="manager")
    assert UserRoleAssignment.objects.filter(user=manager, role__code="branch_manager", branch=ryd).count() == 1


def test_seed_demo_is_idempotent():
    call_command("seed_demo")
    counts = {
        "users": User.objects.count(),
        "memberships": EmployeeMembership.objects.count(),
        "assignments": UserRoleAssignment.objects.count(),
        "branches": Branch.objects.count(),
    }
    call_command("seed_demo")
    call_command("seed_demo")
    assert User.objects.count() == counts["users"]
    assert EmployeeMembership.objects.count() == counts["memberships"]
    assert UserRoleAssignment.objects.count() == counts["assignments"]
    assert Branch.objects.count() == counts["branches"]
    for username in EXPECTED:  # passwords untouched on re-run
        assert User.objects.get(username=username).check_password(EXPECTED[username])
