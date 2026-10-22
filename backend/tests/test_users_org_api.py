"""Users & org API tests: directory exposure, admin create/activate,
scope-gated structure management."""
import pytest

from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.org.models import Department

from .conftest import auth_headers, login

pytestmark = pytest.mark.django_db

USERS_URL = "/api/v1/users/"


def _access(client, username):
    return login(client, username).json()["access"]


# --- directory ------------------------------------------------------------

def test_directory_exposes_only_basic_fields(api_client, user_factory, institute_a, branch_a):
    user_factory("dir_user", membership_unit=branch_a, job_title="محاسب")
    viewer = user_factory("dir_viewer")
    access = _access(api_client, "dir_viewer")
    response = api_client.get(USERS_URL, **auth_headers(access))
    assert response.status_code == 200
    entries = response.json()
    assert len(entries) == 2
    entry = next(e for e in entries if e["username"] == "dir_user")
    assert set(entry.keys()) == {"id", "full_name", "username", "primary_membership"}
    assert entry["primary_membership"]["institute"] == "الأهلي"
    assert entry["primary_membership"]["branch"] == "فرع الرياض"
    assert entry["primary_membership"]["job_title"] == "محاسب"
    # serializer-level leak check: the serialized blob must not carry
    # password/MFA/session material for ANY user
    blob = response.content.decode()
    for forbidden in ("password", "mfa", "secret", "refresh", "argon"):
        assert forbidden not in blob


# --- admin create ---------------------------------------------------------

def test_admin_creates_employee_with_membership(api_client, user_factory, role_factory,
                                                institute_a, branch_a, department_a):
    admin = user_factory("sysadmin1")
    role_factory(admin, "sys_admin")  # central
    access = _access(api_client, "sysadmin1")
    response = api_client.post(
        USERS_URL,
        {
            "username": "newbie",
            "first_name": "موظف",
            "last_name": "جديد",
            "membership": {
                "institute_id": str(institute_a.id),
                "branch_id": str(branch_a.id),
                "department_id": str(department_a.id),
                "job_title": "كاتب",
            },
        },
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 201
    user = User.objects.get(username="newbie")
    assert user.must_change_password is True
    membership = user.memberships.get()
    assert membership.department_id == department_a.id
    assert AuditLog.objects.filter(action="account_created").exists()


def test_admin_create_rejects_inconsistent_membership(api_client, user_factory, role_factory,
                                                      institute_a, branch_b):
    admin = user_factory("sysadmin2")
    role_factory(admin, "sys_admin")
    access = _access(api_client, "sysadmin2")
    response = api_client.post(
        USERS_URL,
        {
            "username": "mixed",
            "membership": {
                "institute_id": str(institute_a.id),
                "branch_id": str(branch_b.id),  # branch belongs to another institute
            },
        },
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 400


def test_plain_employee_cannot_create_users(api_client, user_factory, institute_a):
    user_factory("emp_plain", membership_unit=institute_a)
    access = _access(api_client, "emp_plain")
    response = api_client.post(
        USERS_URL, {"username": "x"}, format="json", **auth_headers(access)
    )
    assert response.status_code == 403


def test_scoped_manager_cannot_create_outside_scope(api_client, user_factory, role_factory,
                                                    institute_a, institute_b):
    manager = user_factory("mgr_a", membership_unit=institute_a)
    role_factory(manager, "institute_manager", institute=institute_a)
    access = _access(api_client, "mgr_a")
    response = api_client.post(
        USERS_URL,
        {"username": "outscope", "membership": {"institute_id": str(institute_b.id)}},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 403
    assert not User.objects.filter(username="outscope").exists()


def test_scoped_sysadmin_creates_inside_scope_only(api_client, user_factory, role_factory,
                                                   institute_a, institute_b, branch_a):
    # accounts.manage_users is held by sys_admin; a scoped sys_admin covers
    # their institute subtree and nothing else.
    admin = user_factory("scoped_admin", membership_unit=institute_a)
    role_factory(admin, "sys_admin", institute=institute_a)
    access = _access(api_client, "scoped_admin")

    ok = api_client.post(
        USERS_URL,
        {"username": "inscope", "membership": {"institute_id": str(institute_a.id),
                                               "branch_id": str(branch_a.id)}},
        format="json",
        **auth_headers(access),
    )
    assert ok.status_code == 201

    denied = api_client.post(
        USERS_URL,
        {"username": "outscope2", "membership": {"institute_id": str(institute_b.id)}},
        format="json",
        **auth_headers(access),
    )
    assert denied.status_code == 403
    assert not User.objects.filter(username="outscope2").exists()


# --- activate / deactivate ------------------------------------------------

def test_deactivate_revokes_sessions_and_blocks_login(api_client, user_factory, role_factory,
                                                      institute_a):
    admin = user_factory("sysadmin3")
    role_factory(admin, "sys_admin")
    target = user_factory("to_deactivate")
    login(api_client, "to_deactivate")  # an active session exists
    access = _access(api_client, "sysadmin3")

    response = api_client.patch(
        f"{USERS_URL}{target.id}/",
        {"is_active": False, "deactivation_reason": "انتهاء تعاقد"},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 200
    target.refresh_from_db()
    assert target.is_active is False
    assert target.deactivated_at is not None
    assert login(api_client, "to_deactivate").status_code == 401
    assert AuditLog.objects.filter(action="account_deactivated").exists()

    re = api_client.patch(
        f"{USERS_URL}{target.id}/", {"is_active": True}, format="json", **auth_headers(access)
    )
    assert re.status_code == 200
    assert login(api_client, "to_deactivate").status_code == 200


# --- org structure CRUD ----------------------------------------------------

def test_org_lists_open_to_authenticated(api_client, user_factory):
    user_factory("browser")
    access = _access(api_client, "browser")
    for url in ("/api/v1/org/institutes/", "/api/v1/org/branches/", "/api/v1/org/departments/"):
        assert api_client.get(url, **auth_headers(access)).status_code == 200


def test_seeded_institutes_present(api_client, user_factory):
    user_factory("seed_check")
    access = _access(api_client, "seed_check")
    names = {i["name"] for i in api_client.get("/api/v1/org/institutes/", **auth_headers(access)).json()}
    assert names == {"الأهلي", "الفاو", "الثقة الدائمة", "المورد الوافي", "آفاق التطور"}


def test_structure_write_requires_permission(api_client, user_factory, institute_a):
    user_factory("no_perm")
    access = _access(api_client, "no_perm")
    response = api_client.post(
        "/api/v1/org/branches/",
        {"institute": str(institute_a.id), "name": "فرع x", "code": "X1"},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 403


def test_structure_scope_enforced_between_institutes(api_client, user_factory, role_factory,
                                                     institute_a, institute_b):
    manager = user_factory("mgr_c", membership_unit=institute_a)
    role_factory(manager, "institute_manager", institute=institute_a)
    access = _access(api_client, "mgr_c")
    # inside own institute: allowed
    ok = api_client.post(
        "/api/v1/org/branches/",
        {"institute": str(institute_a.id), "name": "فرع جديد", "code": "NEW1"},
        format="json",
        **auth_headers(access),
    )
    assert ok.status_code == 201
    # other institute: denied
    bad = api_client.post(
        "/api/v1/org/branches/",
        {"institute": str(institute_b.id), "name": "فرع آخر", "code": "NEW2"},
        format="json",
        **auth_headers(access),
    )
    assert bad.status_code == 403


def test_branch_scope_does_not_cover_institute_level_ops(api_client, user_factory, role_factory,
                                                         institute_a, branch_a):
    """branch-scoped org.manage_structure cannot create new branches
    (that needs institute-level or central scope)."""
    manager = user_factory("mgr_d", membership_unit=branch_a)
    role_factory(manager, "branch_manager", institute=institute_a, branch=branch_a)
    access = _access(api_client, "mgr_d")
    response = api_client.post(
        "/api/v1/org/branches/",
        {"institute": str(institute_a.id), "name": "فرع y", "code": "Y1"},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 403


def test_branch_scope_covers_own_departments(api_client, user_factory, role_factory,
                                             institute_a, branch_a):
    manager = user_factory("mgr_e", membership_unit=branch_a)
    role_factory(manager, "branch_manager", institute=institute_a, branch=branch_a)
    access = _access(api_client, "mgr_e")
    response = api_client.post(
        "/api/v1/org/departments/",
        {"institute": str(institute_a.id), "branch": str(branch_a.id),
         "name": "قسم جديد", "code": "D1"},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 201
    assert Department.objects.filter(code="D1").exists()


def test_department_consistency_validation(api_client, user_factory, role_factory,
                                           institute_a, branch_a, branch_b):
    admin = user_factory("sysadmin4")
    role_factory(admin, "sys_admin")
    access = _access(api_client, "sysadmin4")
    response = api_client.post(
        "/api/v1/org/departments/",
        {"institute": str(institute_a.id), "branch": str(branch_b.id),
         "name": "قسم خاطئ", "code": "BAD1"},
        format="json",
        **auth_headers(access),
    )
    assert response.status_code == 400
