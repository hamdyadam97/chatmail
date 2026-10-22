"""SEC-01/02 (structure level): managers and sysadmins cannot reach other
users' private surfaces, and every user-facing response exposes only the
basic field whitelist — no serializer leaks sensitive fields."""
import pytest

from apps.audit.models import AuditLog

from .conftest import auth_headers, login

pytestmark = pytest.mark.django_db

USERS_URL = "/api/v1/users/"


def _access(client, username):
    return login(client, username).json()["access"]


@pytest.fixture
def workplace(user_factory, role_factory, institute_a, branch_a):
    employee = user_factory("emp_sec", membership_unit=branch_a)
    manager = user_factory("mgr_sec", membership_unit=branch_a)
    role_factory(manager, "branch_manager", institute=institute_a, branch=branch_a)
    admin = user_factory("adm_sec")
    role_factory(admin, "sys_admin")
    return employee, manager, admin


def test_branch_manager_denied_on_employee_private_surfaces(api_client, workplace):
    """SEC-01: مدير فرع لا يقرأ/يدير أسطح الموظف الخاصة — 403 عند كل نقطة."""
    employee, manager, _ = workplace
    access = _access(api_client, "mgr_sec")

    detail = api_client.get(f"{USERS_URL}{employee.id}/", **auth_headers(access))
    assert detail.status_code == 403

    reset = api_client.post(
        f"{USERS_URL}{employee.id}/reset-password/", **auth_headers(access)
    )
    assert reset.status_code == 403

    patch = api_client.patch(
        f"{USERS_URL}{employee.id}/",
        {"is_active": False},
        format="json",
        **auth_headers(access),
    )
    assert patch.status_code == 403

    # every one of those denials is audited
    denials = AuditLog.objects.filter(action="unauthorized_access_denied")
    assert denials.count() == 3
    assert all(d.metadata["status"] == 403 for d in denials)


def test_sys_admin_user_responses_still_basic_only(api_client, workplace, branch_a):
    """SEC-02: even a full sys_admin gets ONLY the whitelisted basic fields
    for other users — no password hash, no MFA state, no session data,
    and no crypto key material (which doesn't exist yet at all)."""
    employee, _, admin = workplace
    access = _access(api_client, "adm_sec")

    detail = api_client.get(f"{USERS_URL}{employee.id}/", **auth_headers(access))
    assert detail.status_code == 200
    assert set(detail.json().keys()) == {"id", "full_name", "username", "primary_membership"}

    directory = api_client.get(USERS_URL, **auth_headers(access))
    blob = directory.content.decode()
    for forbidden in (
        "password", "argon", "mfa", "secret", "refresh_token", "ciphertext",
        "identity_sign_pub", "kem_pub", "must_change_password", "is_active",
    ):
        assert forbidden not in blob, f"leaked field: {forbidden}"
    entry = next(e for e in directory.json() if e["username"] == "emp_sec")
    assert entry["primary_membership"]["branch"] == branch_a.name


def test_sys_admin_reset_password_response_is_minimal(api_client, workplace):
    """SEC-02 + SEC-08: the admin surface response carries the temp password
    and nothing else — it structurally cannot return key material."""
    employee, _, admin = workplace
    access = _access(api_client, "adm_sec")
    response = api_client.post(
        f"{USERS_URL}{employee.id}/reset-password/", **auth_headers(access)
    )
    assert response.status_code == 200
    assert set(response.json().keys()) == {"temp_password"}
    assert len(response.json()["temp_password"]) == 16


def test_unauthenticated_requests_denied_and_audited(api_client, user_factory, branch_a):
    user_factory("someone", membership_unit=branch_a)
    directory = api_client.get(USERS_URL)
    assert directory.status_code in (401, 403)
    assert AuditLog.objects.filter(action="unauthorized_access_denied").exists()
