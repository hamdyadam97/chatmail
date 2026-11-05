"""Employee administration: scoped managed-user listing, memberships
(multi-branch, transfer), remote sign-out, role catalog — and the SEC-08
separation: none of it touches devices or crypto identities."""
import pytest

from apps.accounts.models import TrustedDevice, UserSession
from apps.audit.models import AuditLog
from apps.org.models import EmployeeMembership

from .conftest import assign_role
from .correspondence_utils import make_employee
from .messaging_utils import auth, make_device

pytestmark = pytest.mark.django_db

USERS = "/api/v1/users/"


@pytest.fixture
def staff(api_client, user_factory, branch_a, branch_a2, branch_b, department_a):
    central = user_factory("adm_central", membership_unit=branch_a)
    assign_role(central, "sys_admin")  # accounts.manage_users + manage_sessions + org.manage_structure (central)
    scoped = user_factory("adm_ryd", membership_unit=branch_a)
    assign_role(scoped, "sys_admin", institute=branch_a.institute, branch=branch_a)  # same role, branch scope
    manager = make_employee(user_factory, "adm_mgr", branch_a)
    assign_role(manager, "branch_manager", institute=branch_a.institute, branch=branch_a)
    emp = make_employee(user_factory, "adm_emp", branch_a)
    jed = make_employee(user_factory, "adm_jed", branch_a2)
    faw = make_employee(user_factory, "adm_faw", branch_b)
    return {
        "central": central, "scoped": scoped, "manager": manager, "emp": emp, "jed": jed, "faw": faw,
        "h_central": auth(api_client, "adm_central"), "h_scoped": auth(api_client, "adm_ryd"),
        "h_mgr": auth(api_client, "adm_mgr"), "h_emp": auth(api_client, "adm_emp"),
        "branch_a": branch_a, "branch_a2": branch_a2, "branch_b": branch_b, "department_a": department_a,
    }


def _usernames(resp):
    return {u["username"] for u in resp.json()["results"]}


def test_managed_list_is_scoped(api_client, staff):
    everyone = _usernames(api_client.get(f"{USERS}managed/?page_size=100", **staff["h_central"]))
    assert {"adm_emp", "adm_jed", "adm_faw"} <= everyone
    scoped = _usernames(api_client.get(f"{USERS}managed/?page_size=100", **staff["h_scoped"]))
    assert "adm_emp" in scoped and "adm_jed" not in scoped and "adm_faw" not in scoped
    assert api_client.get(f"{USERS}managed/", **staff["h_emp"]).status_code == 403
    assert api_client.get(f"{USERS}managed/", **staff["h_mgr"]).status_code == 403  # no manage_users


def test_managed_list_includes_inactive_and_filters(api_client, staff):
    resp = api_client.patch(f"{USERS}{staff['emp'].id}/", {"is_active": False, "deactivation_reason": "استقالة"},
                            format="json", **staff["h_central"])
    assert resp.status_code == 200
    inactive = _usernames(api_client.get(f"{USERS}managed/?status=inactive", **staff["h_central"]))
    assert inactive == {"adm_emp"}
    found = _usernames(api_client.get(f"{USERS}managed/?q=adm_je", **staff["h_central"]))
    assert found == {"adm_jed"}


def test_delete_only_an_account_never_used(api_client, user_factory, staff):
    from django.utils import timezone

    from apps.accounts.models import User
    from apps.authorization.services import grant_default_role

    from .correspondence_utils import make_employee

    # imported and never used: membership + automatic role + notification settings → deletable
    fresh = make_employee(user_factory, "adm_fresh", staff["branch_a"])
    grant_default_role(fresh, staff["branch_a"].institute, granted_by=staff["central"])
    assert api_client.delete(f"{USERS}{fresh.id}/", **staff["h_emp"]).status_code == 403
    assert api_client.delete(f"{USERS}{fresh.id}/", **staff["h_central"]).status_code == 204
    assert not User.objects.filter(id=fresh.id).exists()
    entry = AuditLog.objects.get(action="account_deleted", target_id=fresh.id)
    assert entry.metadata["username"] == "adm_fresh" and entry.actor_id == staff["central"].id

    # logged in once → kept
    User.objects.filter(id=staff["jed"].id).update(last_login_at=timezone.now())
    assert api_client.delete(f"{USERS}{staff['jed'].id}/", **staff["h_central"]).status_code == 409
    # acted in the audit log (even without a recorded login) → kept, and the log is never rewritten
    quiet = make_employee(user_factory, "adm_quiet", staff["branch_a"])
    AuditLog.objects.create(actor=quiet, action="login_failed")
    resp = api_client.delete(f"{USERS}{quiet.id}/", **staff["h_central"])
    assert resp.status_code == 409 and "audit.auditlog" in resp.json()["used"]
    # received a correspondence without ever logging in → kept
    from .correspondence_utils import prepare_and_send

    recipient = make_employee(user_factory, "adm_inbox", staff["branch_a"])
    prepare_and_send(api_client, staff["h_emp"], [recipient])
    resp = api_client.delete(f"{USERS}{recipient.id}/", **staff["h_central"])
    assert resp.status_code == 409 and User.objects.filter(id=recipient.id).exists()
    # never one's own account
    assert api_client.delete(f"{USERS}{staff['central'].id}/", **staff["h_central"]).status_code == 403


def test_new_account_gets_the_shared_temp_password_when_configured(api_client, staff, settings):
    from apps.accounts.models import User

    def create(username):
        body = {"username": username, "first_name": "س", "last_name": "ع", "phone": "",
                "membership": {"institute_id": str(staff["branch_a"].institute.id),
                               "branch_id": str(staff["branch_a"].id)}}
        return api_client.post(USERS, body, format="json", **staff["h_central"])

    settings.NEW_ACCOUNT_TEMP_PASSWORD = ""
    resp = create("adm_new1")
    assert resp.status_code == 201 and "temp_password" not in resp.json()
    assert not User.objects.get(username="adm_new1").has_usable_password()

    settings.NEW_ACCOUNT_TEMP_PASSWORD = "Shared@2025*"
    resp = create("adm_new2")
    assert resp.status_code == 201 and resp.json()["temp_password"] == "Shared@2025*"
    user = User.objects.get(username="adm_new2")
    assert user.check_password("Shared@2025*") and user.must_change_password
    entry = AuditLog.objects.get(action="account_created", target_id=user.id)
    assert "Shared@2025*" not in str(entry.metadata)

    # a username the shared password would contain → falls back to no password (random via reset)
    resp = create("shared")
    assert resp.status_code == 201 and "temp_password" not in resp.json()


def test_managed_list_filters_by_branch(api_client, user_factory, staff):
    user_factory("adm_nobranch")  # imported without a branch: no membership
    url = f"{USERS}managed/?page_size=100&branch="
    in_a2 = _usernames(api_client.get(url + str(staff["branch_a2"].id), **staff["h_central"]))
    assert in_a2 == {"adm_jed"}
    none = _usernames(api_client.get(url + "none", **staff["h_central"]))
    assert "adm_nobranch" in none and not {"adm_emp", "adm_jed", "adm_faw"} & none
    # the branch filter never widens a scoped manager's list
    assert _usernames(api_client.get(url + str(staff["branch_b"].id), **staff["h_scoped"])) == set()
    assert api_client.get(url + "bad", **staff["h_central"]).status_code == 400


def test_add_secondary_membership_multi_branch(api_client, staff):
    url = f"{USERS}{staff['emp'].id}/memberships/"
    body = {"institute": str(staff["branch_a2"].institute_id), "branch": str(staff["branch_a2"].id),
            "job_title": "منسق", "is_primary": False}
    # the RYD branch manager cannot staff the JED branch
    assert api_client.post(url, body, format="json", **staff["h_mgr"]).status_code == 403
    resp = api_client.post(url, body, format="json", **staff["h_central"])
    assert resp.status_code == 201, resp.content
    ms = api_client.get(url, **staff["h_central"]).json()
    assert [m["is_primary"] for m in ms] == [True, False]
    assert {m["branch"]["code"] for m in ms} == {"RYD", "JED"}
    assert EmployeeMembership.objects.filter(user=staff["emp"], is_primary=True).count() == 1


def test_membership_must_be_consistent(api_client, staff):
    body = {"institute": str(staff["branch_b"].institute_id), "branch": str(staff["branch_a"].id)}
    resp = api_client.post(f"{USERS}{staff['emp'].id}/memberships/", body, format="json", **staff["h_central"])
    assert resp.status_code == 400


def test_branch_manager_moves_staff_within_branch_only(api_client, staff):
    url = f"{USERS}{staff['emp'].id}/transfer/"
    dept = staff["department_a"]
    ok = api_client.post(url, {"institute": str(dept.institute_id), "branch": str(dept.branch_id),
                               "department": str(dept.id), "job_title": "محاسب"}, format="json", **staff["h_mgr"])
    assert ok.status_code == 201, ok.content
    current = EmployeeMembership.objects.get(user=staff["emp"], is_primary=True)
    assert current.department_id == dept.id
    assert EmployeeMembership.objects.filter(user=staff["emp"], ended_on__isnull=False).count() == 1
    # out of the manager's branch → refused (needs structure perm on the destination)
    out = api_client.post(url, {"institute": str(staff["branch_a2"].institute_id), "branch": str(staff["branch_a2"].id)},
                          format="json", **staff["h_mgr"])
    assert out.status_code == 403
    assert AuditLog.objects.filter(action="employee_transferred", target_id=staff["emp"].id).count() == 1


def test_transfer_to_another_institute_grants_employee_there_once(api_client, staff):
    faw_institute = staff["branch_b"].institute
    url = f"{USERS}{staff['emp'].id}/transfer/"
    body = {"institute": str(faw_institute.id), "branch": str(staff["branch_b"].id)}
    assert api_client.post(url, body, format="json", **staff["h_central"]).status_code == 201
    assert staff["emp"].role_assignments.filter(role__code="employee", institute=faw_institute).count() == 1
    # moving again inside the same institute adds nothing
    assert api_client.post(url, body, format="json", **staff["h_central"]).status_code == 201
    assert staff["emp"].role_assignments.filter(role__code="employee", institute=faw_institute).count() == 1


def test_end_and_promote_memberships(api_client, staff):
    url = f"{USERS}{staff['emp'].id}/memberships/"
    second = api_client.post(url, {"institute": str(staff["branch_a2"].institute_id), "branch": str(staff["branch_a2"].id)},
                             format="json", **staff["h_central"]).json()
    primary = next(m for m in api_client.get(url, **staff["h_central"]).json() if m["is_primary"])
    assert api_client.patch(f"{url}{primary['id']}/", {"end": True}, format="json",
                            **staff["h_central"]).status_code == 400
    promoted = api_client.patch(f"{url}{second['id']}/", {"make_primary": True}, format="json", **staff["h_central"])
    assert promoted.json()["is_primary"] is True
    ended = api_client.patch(f"{url}{primary['id']}/", {"end": True}, format="json", **staff["h_central"])
    assert ended.json()["ended_on"] is not None


def test_remote_sign_out_needs_manage_sessions_and_spares_devices(api_client, staff):
    device = make_device(staff["emp"])
    before = list(TrustedDevice.objects.filter(user=staff["emp"]).values())
    assert UserSession.objects.filter(user=staff["emp"], revoked_at__isnull=True).exists()
    url = f"{USERS}{staff['emp'].id}/revoke-sessions/"
    assert api_client.post(url, **staff["h_mgr"]).status_code == 403
    resp = api_client.post(url, **staff["h_scoped"])
    assert resp.status_code == 200 and resp.json()["revoked"] >= 1
    assert not UserSession.objects.filter(user=staff["emp"], revoked_at__isnull=True).exists()
    # SEC-08: login administration never touches devices/keys
    assert list(TrustedDevice.objects.filter(user=staff["emp"]).values()) == before
    assert TrustedDevice.objects.get(id=device.id).status == "active"
    # out of scope
    assert api_client.post(f"{USERS}{staff['faw'].id}/revoke-sessions/", **staff["h_scoped"]).status_code == 403


def test_role_catalog_is_transparent(api_client, staff):
    roles = {r["code"]: r for r in api_client.get("/api/v1/roles/catalog/", **staff["h_emp"]).json()}
    assert "branch_manager" in roles and "sys_admin" in roles
    codes = {p["code"] for r in roles.values() for p in r["permissions"]}
    assert not any("view_all" in c or "decrypt" in c for c in codes)


def test_export_managed_list_follows_scope_and_filters(api_client, staff):
    import io

    import openpyxl

    def export(headers, query=""):
        return api_client.get(f"{USERS}managed/export/{query}", **headers)

    resp = export(staff["h_central"], f"?branch={staff['branch_a2'].id}")
    assert resp.status_code == 200 and resp["Content-Disposition"].startswith("attachment")
    rows = list(openpyxl.load_workbook(io.BytesIO(resp.content)).active.iter_rows(values_only=True))
    assert rows[0][:3] == ("الاسم", "اسم المستخدم", "الفرع")
    assert [r[1] for r in rows[1:]] == ["adm_jed"] and rows[1][2] == staff["branch_a2"].name
    entry = AuditLog.objects.get(action="employees_exported")
    assert entry.actor_id == staff["central"].id and entry.metadata["count"] == 1

    scoped = {r[1] for r in list(openpyxl.load_workbook(io.BytesIO(export(staff["h_scoped"]).content)).active.iter_rows(values_only=True))[1:]}
    assert "adm_emp" in scoped and not {"adm_jed", "adm_faw"} & scoped
    assert export(staff["h_emp"]).status_code == 403


def test_export_never_writes_formulas(api_client, staff, user_factory):
    import io

    import openpyxl

    from apps.accounts.models import User

    User.objects.filter(id=staff["emp"].id).update(full_name="=HYPERLINK(\"http://x\")")
    data = api_client.get(f"{USERS}managed/export/?q=adm_emp", **staff["h_central"]).content
    cell = openpyxl.load_workbook(io.BytesIO(data)).active["A2"]
    assert cell.data_type == "s" and cell.value.startswith("=HYPERLINK")
