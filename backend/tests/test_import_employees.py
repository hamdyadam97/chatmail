"""import_employees: dry run writes nothing; apply creates accounts in their
branch with the employee role, a one-time password, and skips what it should."""
import openpyxl
import pytest
from django.core.management import call_command

from apps.accounts.models import User

pytestmark = pytest.mark.django_db
HEADER = ("الاسم", "البريد الإلكتروني", "الدور", "الفرع", "المعهد", "القسم", "الحالة", "آخر دخول", "ملاحظة")


@pytest.fixture
def sheet(tmp_path, branch_a, user_factory):
    from .conftest import assign_role

    assign_role(user_factory("it.admin"), "sys_admin")
    user_factory("taken")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(HEADER)
    b, i = f"فرع {branch_a.name} — رجال", branch_a.institute.name
    ws.append(("أحمد كامل", "Ahmed.Kamal@ararhni.com", "موظف", b, i, None, "نشط", "", None))
    ws.append(("بلا فرع", "nobranch@ararhni.com", None, None, None, None, "نشط", "", "يحتاج فرع"))
    ws.append(("تجربة", "dev@root-jo.com", None, None, None, None, "نشط", "", "حساب تجربة/مبرمج؟"))
    ws.append(("مكرر", "ali_x@ararhni.com", None, None, None, None, "نشط", "", "مكرر محتمل مع ali.x@ararhni.com"))
    ws.append(("موجود", "taken@ararhni.com", "موظف", b, i, None, "نشط", "", None))
    ws.append(("فرع مجهول", "lost@ararhni.com", "موظف", "فرع غير موجود", i, None, "نشط", "", None))
    path = tmp_path / "staff.xlsx"
    wb.save(path)
    return path


def test_dry_run_then_apply(sheet, tmp_path, branch_a, capsys):
    call_command("import_employees", str(sheet))
    out = capsys.readouterr().out
    assert "dry run" in out and "فرع غير موجود" in out
    assert not User.objects.filter(username="ahmed.kamal").exists()

    report = tmp_path / "passwords.xlsx"
    call_command("import_employees", str(sheet), "--apply", "--out", str(report))
    ahmed = User.objects.get(username="ahmed.kamal")
    assert ahmed.full_name == "أحمد كامل" and ahmed.must_change_password and ahmed.optional_email is None
    assert ahmed.memberships.get().branch_id == branch_a.id
    assert ahmed.role_assignments.filter(role__code="employee", institute=branch_a.institute).exists()
    assert User.objects.filter(username="nobranch").exists()
    for skipped in ("dev", "ali_x", "lost"):
        assert not User.objects.filter(username=skipped).exists()

    rows = list(openpyxl.load_workbook(report).active.iter_rows(values_only=True))
    by_user = {r[1]: r for r in rows[1:]}
    password = by_user["ahmed.kamal"][2]
    assert ahmed.check_password(password) and by_user["ahmed.kamal"][4] == "أُنشئ"
    assert by_user["taken"][4] == "موجود مسبقًا" and not by_user["dev"][2]


def test_missing_branches_are_created_per_city_without_gender(tmp_path, institute_a, user_factory, capsys):
    from apps.org.models import Branch

    from .conftest import assign_role

    assign_role(user_factory("it.admin"), "sys_admin")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(HEADER)
    inst = institute_a.name
    ws.append(("أ", "a1@x.com", "موظف", f"فرع {inst} بسكاكا — رجال", inst, None, "نشط", "", None))
    ws.append(("ب", "b1@x.com", "موظف", f"فرع {inst} بسكاكا — نساء", inst, None, "نشط", "", None))
    ws.append(("ج", "c1@x.com", "موظف", f"فرع {inst} بالدمام — رجال", inst, None, "نشط", "", None))
    ws.append(("د", "d1@x.com", "موظف", "فرع مجهول بعرعر — رجال", "معهد لا يوجد", None, "نشط", "", None))
    path = tmp_path / "s.xlsx"
    wb.save(path)
    call_command("import_employees", str(path), "--create-branches")
    assert "فرع جديد" in capsys.readouterr().out and not Branch.objects.filter(code="SKK").exists()
    call_command("import_employees", str(path), "--create-branches", "--apply", "--out", str(tmp_path / "p.xlsx"))
    skk = Branch.objects.get(institute=institute_a, code="SKK")
    assert skk.name == f"فرع {inst} بسكاكا"
    assert {u.memberships.get().branch_id for u in User.objects.filter(username__in=["a1", "b1"])} == {skk.id}
    assert Branch.objects.filter(institute=institute_a, code="DMM").exists()
    assert not User.objects.filter(username="d1").exists()


def _upload(api_client, headers, path, **fields):
    with open(path, "rb") as fh:
        return api_client.post("/api/v1/users/import/", {"file": fh, **fields}, format="multipart", **headers)


def test_import_from_the_employees_page(api_client, sheet, tmp_path, branch_a, branch_b, user_factory, settings):
    from apps.audit.models import AuditLog

    from .conftest import assign_role
    from .messaging_utils import auth

    settings.NEW_ACCOUNT_TEMP_PASSWORD = ""
    h_admin = auth(api_client, "it.admin")
    preview = _upload(api_client, h_admin, sheet)
    assert preview.status_code == 200 and not preview.json()["applied"]
    rows = {r["username"]: r for r in preview.json()["rows"]}
    assert rows["ahmed.kamal"]["will_create"] and rows["ahmed.kamal"]["branch_matched"] == branch_a.name
    assert rows["taken"]["status"] == "موجود مسبقًا" and not rows["lost"]["will_create"]
    assert not User.objects.filter(username="ahmed.kamal").exists()

    done = _upload(api_client, h_admin, sheet, apply="1")
    body = done.json()
    assert body["created"] == 2 and body["shared_temp_password"] is None
    rows = {r["username"]: r for r in body["rows"]}
    ahmed = User.objects.get(username="ahmed.kamal")
    assert ahmed.check_password(rows["ahmed.kamal"]["temp_password"]) and ahmed.must_change_password
    assert ahmed.role_assignments.filter(role__code="employee").exists()
    entry = AuditLog.objects.get(action="account_created", target_id=ahmed.id)
    assert entry.metadata["via"] == "employees_page" and rows["ahmed.kamal"]["temp_password"] not in str(entry.metadata)

    # shared temporary password: returned once at the top, not per row
    settings.NEW_ACCOUNT_TEMP_PASSWORD = "Shared@2025*"
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(("الاسم", "اسم المستخدم", "الفرع"))
    ws.append(("سعد", "saad.x", branch_a.name))
    ws.append(("فهد", "fahd.x", branch_b.name))
    two = tmp_path / "two.xlsx"
    wb.save(two)
    body = _upload(api_client, h_admin, two, apply="1").json()
    assert body["shared_temp_password"] == "Shared@2025*" and "temp_password" not in body["rows"][0]
    assert User.objects.get(username="saad.x").check_password("Shared@2025*")

    # a branch-scoped admin creates only inside their branch; an employee cannot import at all
    scoped = user_factory("imp_scoped", membership_unit=branch_a)
    assign_role(scoped, "sys_admin", institute=branch_a.institute, branch=branch_a)
    ws.delete_rows(2, 2)
    ws.append(("ريم", "reem.x", branch_a.name))
    ws.append(("نورة", "noura.x", branch_b.name))
    ws.append(("هند", "hind.x", ""))
    wb.save(two)
    rows = {r["username"]: r for r in _upload(api_client, auth(api_client, "imp_scoped"), two, apply="1").json()["rows"]}
    assert rows["reem.x"]["created"] and rows["noura.x"]["status"] == "خارج نطاق صلاحيتك"
    assert rows["hind.x"]["status"] == "خارج نطاق صلاحيتك" and not User.objects.filter(username="noura.x").exists()
    assert _upload(api_client, auth(api_client, "imp_scoped"), two, create_branches="1").status_code == 403
    user_factory("imp_emp", membership_unit=branch_a)
    assert _upload(api_client, auth(api_client, "imp_emp"), two).status_code == 403

    # not a spreadsheet / wrong columns → a clear 400
    bad = tmp_path / "bad.xlsx"
    bad.write_bytes(b"not a workbook")
    assert _upload(api_client, h_admin, bad).status_code == 400
    wb2 = openpyxl.Workbook()
    wb2.active.append(("x", "y"))
    wb2.save(bad)
    assert "الاسم" in str(_upload(api_client, h_admin, bad).json())
    template = api_client.get("/api/v1/users/import/template/", **h_admin)
    assert template.status_code == 200
    import io
    assert next(openpyxl.load_workbook(io.BytesIO(template.content)).active.iter_rows(values_only=True))[0] == "الاسم"
