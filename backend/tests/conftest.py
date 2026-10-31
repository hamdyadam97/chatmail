"""Shared fixtures for the backend security suites."""

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.authorization.models import Role, UserRoleAssignment
from apps.org.models import Branch, Department, EmployeeMembership, Institute

DEFAULT_PASSWORD = "Str0ng!Passw0rd"


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    """Throttle counters must not leak between tests."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def api_client():
    return APIClient()


# --- org fixtures ---------------------------------------------------------

@pytest.fixture
def institute_a(db):
    return Institute.objects.get(code="AHL")


@pytest.fixture
def institute_b(db):
    return Institute.objects.get(code="FAW")


@pytest.fixture
def branch_a(institute_a):
    return Branch.objects.create(institute=institute_a, name="فرع الرياض", code="RYD", city="الرياض")


@pytest.fixture
def branch_a2(institute_a):
    return Branch.objects.create(institute=institute_a, name="فرع جدة", code="JED", city="جدة")


@pytest.fixture
def branch_b(institute_b):
    return Branch.objects.create(institute=institute_b, name="فرع الفاو", code="FAW-B1", city="الدمام")


@pytest.fixture
def department_a(branch_a):
    return Department.objects.create(
        institute=branch_a.institute, branch=branch_a, name="قسم الموارد البشرية", code="HR"
    )


# --- user helpers ---------------------------------------------------------

def make_user(username, password=DEFAULT_PASSWORD, full_name=None, membership_unit=None,
              job_title="موظف", is_active=True):
    user = User(
        username=username,
        first_name="مستخدم",
        last_name=username,
        full_name=full_name or f"مستخدم {username}",
        must_change_password=False,
        is_active=is_active,
    )
    user.set_password(password)
    user.save()
    if membership_unit is not None:
        if isinstance(membership_unit, Department):
            EmployeeMembership.objects.create(
                user=user, institute=membership_unit.institute, branch=membership_unit.branch,
                department=membership_unit, job_title=job_title, is_primary=True,
                started_on="2024-01-01",
            )
        elif isinstance(membership_unit, Branch):
            EmployeeMembership.objects.create(
                user=user, institute=membership_unit.institute, branch=membership_unit,
                job_title=job_title, is_primary=True, started_on="2024-01-01",
            )
        elif isinstance(membership_unit, Institute):
            EmployeeMembership.objects.create(
                user=user, institute=membership_unit, job_title=job_title,
                is_primary=True, started_on="2024-01-01",
            )
    return user


def assign_role(user, role_code, institute=None, branch=None, department=None, granted_by=None):
    return UserRoleAssignment.objects.create(
        user=user,
        role=Role.objects.get(code=role_code),
        institute=institute,
        branch=branch,
        department=department,
        granted_by=granted_by,
    )


def login(client, username, password=DEFAULT_PASSWORD):
    return client.post(
        "/api/v1/auth/login/", {"username": username, "password": password}, format="json"
    )


def auth_headers(access_token):
    return {"HTTP_AUTHORIZATION": f"Bearer {access_token}"}


@pytest.fixture
def user_factory():
    return make_user


@pytest.fixture
def role_factory():
    return assign_role


def login_and_get_access(client, username, password=DEFAULT_PASSWORD) -> str:
    """Login via the real auth endpoint and arm the client with the token."""
    resp = login(client, username, password)
    assert resp.status_code == 200, resp.content
    access = resp.json()["access"]
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")
    return access
