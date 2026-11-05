"""Bulk employee import from a spreadsheet — shared by the
`import_employees` command and the employees page (POST /users/import/).

Columns (first sheet, by header): الاسم، and اسم المستخدم or البريد الإلكتروني
(the username is the part before "@"; the e-mail is not stored), optional
الفرع، المعهد، ملاحظة. Each account gets a temporary password (the shared
NEW_ACCOUNT_TEMP_PASSWORD when set and acceptable, otherwise a random one),
must change it at first login, a primary membership in its branch and the
employee role there. Rows are skipped, with the reason, when the username is
invalid, exists, repeats in the file, is marked as a test account, or is a
branch-less "possible duplicate". Rows without a branch are created without a
membership — assign their branch from the employees page.

Branches: men and women share one branch, so "— رجال/نساء" is dropped.
create_branches adds a missing branch under the row's institute, coded by its
city; an existing branch of that institute with the same code is reused.
"""
import re
from collections import Counter

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.audit.services import log
from apps.authorization.services import grant_default_role
from apps.org.models import Branch, EmployeeMembership, Institute
from apps.textsearch import normalize

from .models import User
from .password_policy import generate_temp_password, validate_password_policy

NAME, USERNAME, EMAIL, BRANCH, INSTITUTE, NOTE = "الاسم", "اسم المستخدم", "البريد الإلكتروني", "الفرع", "المعهد", "ملاحظة"
TEMPLATE_HEADER = [NAME, USERNAME, BRANCH, INSTITUTE, NOTE]
MAX_ROWS = 3000
USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
GENDER_SUFFIX = re.compile(r"\s*[—–-]\s*(رجال|نساء)\s*$")
CITY_CODES = {
    "الرياض": "RYD", "سكاكا": "SKK", "عرعر": "ARR", "القصيم": "QSM", "طريف": "TRF",
    "القريات": "QRY", "خميس مشيط": "KMS", "الدمام": "DMM", "جدة": "JED", "مكة": "MKH",
    "المدينة": "MED", "تبوك": "TBK", "حائل": "HAL", "أبها": "ABH", "الجوف": "JOF",
}
CREATE = "سيُنشأ"
CREATE_NO_BRANCH = "سيُنشأ بلا فرع"


class ImportError_(ValueError):
    """The file itself is unusable (message is shown to the admin)."""


def branch_name(raw: str) -> str:
    return GENDER_SUFFIX.sub("", raw or "").strip()


def city_code(name: str) -> str:
    norm = normalize(name)
    for city, code in CITY_CODES.items():
        if normalize(city) in norm:
            return code
    return "MAIN"


def _key(text: str) -> str:
    """Branch/institute names compared loosely: Arabic normalization, no
    dashes/spaces, without the words فرع/معهد."""
    text = normalize(text or "")
    text = re.sub(r"\b(فرع|معهد)\b", " ", text)
    return re.sub(r"[\s\-—–_]+", "", text)


def _find_branch(branches: dict, name: str):
    """The system branch with the same (normalized) name, with or without the
    "— رجال/نساء" suffix. No partial matching: "الفاو المتقدم بالرياض" must
    never land on another institute's "فرع الرياض"."""
    return branches.get(_key(name)) or branches.get(_key(branch_name(name)))


def read_records(fileobj) -> list[dict]:
    import openpyxl

    try:
        sheet = openpyxl.load_workbook(fileobj, read_only=True, data_only=True).worksheets[0]
    except Exception as exc:  # noqa: BLE001 - any unreadable workbook
        raise ImportError_("تعذرت قراءة الملف — ارفع ملف Excel بصيغة ‎.xlsx") from exc
    rows = sheet.iter_rows(values_only=True)
    header = [str(h or "").strip() for h in next(rows, ())]
    if NAME not in header or (USERNAME not in header and EMAIL not in header):
        raise ImportError_(f"الصف الأول يجب أن يحوي عمود «{NAME}» وعمود «{USERNAME}» أو «{EMAIL}».")
    idx = {h: header.index(h) for h in (NAME, USERNAME, EMAIL, BRANCH, INSTITUTE, NOTE) if h in header}

    records = []
    for r in rows:
        def get(h):
            i = idx.get(h)
            return str(r[i] if i is not None and i < len(r) and r[i] is not None else "").strip()

        username = get(USERNAME) or get(EMAIL).split("@", 1)[0].strip()
        if not username and not get(NAME):
            continue
        records.append({"name": get(NAME), "username": username.lower(), "branch": get(BRANCH),
                        "institute": get(INSTITUTE), "note": get(NOTE)})
        if len(records) > MAX_ROWS:
            raise ImportError_(f"الملف أكبر من الحد ({MAX_ROWS} صف).")
    if not records:
        raise ImportError_("لا توجد صفوف موظفين في الملف.")
    return records


def plan(records, *, include_test=False, create_branches=False, allowed=None):
    """Annotate each record with status / branch_obj. `allowed(branch_or_None)`
    limits which rows this admin may create. Returns (plan, new_branches)."""
    seen = Counter(rec["username"] for rec in records)
    existing = set(User.objects.filter(username__in=list(seen)).values_list("username", flat=True))
    branches = {_key(b.name): b for b in Branch.objects.select_related("institute")}
    institutes = {_key(i.name): i for i in Institute.objects.all()}
    new_branches: dict[str, Branch] = {}
    out, done = [], set()
    for rec in records:
        u, status, branch = rec["username"], "", None
        if not u:
            status = "بلا اسم مستخدم"
        elif not USERNAME_RE.match(u):
            status = "اسم مستخدم غير صالح"
        elif u in existing:
            status = "موجود مسبقًا"
        elif u in done:
            status = "مكرر في الملف"
        elif "تجربة" in rec["note"] and not include_test:
            status = "حساب تجربة — لم يُستورد"
        elif "مكرر محتمل" in rec["note"] and not rec["branch"]:
            status = "مكرر محتمل بلا فرع — لم يُستورد"
        elif rec["branch"]:
            branch = _find_branch(branches, rec["branch"])
            if branch is None and create_branches:
                branch, why = _branch_to_create(rec, institutes, new_branches)
                status = why
            if branch is None and not status:
                status = "الفرع غير موجود في النظام"
            elif branch is not None and rec["institute"] and institutes.get(_key(rec["institute"])) not in (None, branch.institute):
                status, branch = "الفرع لا يتبع المعهد المكتوب", None
        if not status and allowed is not None and not allowed(branch):
            status, branch = "خارج نطاق صلاحيتك", None
        if not status:
            status = CREATE if branch else CREATE_NO_BRANCH
            done.add(u)
        out.append({**rec, "status": status, "branch_obj": branch})
    return out, new_branches


def _branch_to_create(rec, institutes, new_branches):
    """(branch, "") — existing same-code branch or a new unsaved one — or (None, reason)."""
    name = branch_name(rec["branch"])
    key = _key(name)
    if key in new_branches:
        return new_branches[key], ""
    institute = institutes.get(_key(rec["institute"])) if rec["institute"] else None
    if institute is None:
        hits = [i for k, i in institutes.items() if k and k in key]
        institute = hits[0] if len(hits) == 1 else None
    if institute is None:
        return None, "المعهد غير موجود في النظام"
    code = city_code(name)
    branch = Branch.objects.filter(institute=institute, code=code).first()
    if branch is None:
        branch = Branch(institute=institute, name=name, code=code)
    new_branches[key] = branch
    return branch, ""


def temp_password_for(username: str) -> tuple[str, bool]:
    """(password, shared?) — the shared NEW_ACCOUNT_TEMP_PASSWORD when set
    and acceptable for this username, otherwise a random one."""
    shared = getattr(settings, "NEW_ACCOUNT_TEMP_PASSWORD", "") or ""
    if shared:
        try:
            validate_password_policy(username, shared)
            return shared, True
        except Exception:  # noqa: BLE001 - policy rejection → random
            pass
    return generate_temp_password(username), False


def apply(rows, new_branches, *, admin, via, request_ctx=None) -> int:
    """Create the accounts planned as CREATE / CREATE_NO_BRANCH. Sets
    row["password"], row["shared_password"] and the final status."""
    ctx = request_ctx or {}
    created = 0
    with transaction.atomic():
        for b in new_branches.values():
            if b._state.adding:
                b.save()
                log(actor=admin, action="branch_created", target_type="branch", target_id=b.id,
                    metadata={"code": b.code, "via": via}, **ctx)
        for p in rows:
            if p["status"] not in (CREATE, CREATE_NO_BRANCH):
                continue
            password, shared = temp_password_for(p["username"])
            user = User(username=p["username"], first_name=p["name"], full_name=p["name"] or p["username"],
                        must_change_password=True, password_changed_at=timezone.now())
            user.set_password(password)
            user.save()
            if p["branch_obj"] is not None:
                EmployeeMembership.objects.create(
                    user=user, institute=p["branch_obj"].institute, branch=p["branch_obj"],
                    is_primary=True, started_on=timezone.localdate(),
                )
                grant_default_role(user, p["branch_obj"].institute, granted_by=admin)
            log(actor=admin, action="account_created", target_type="user", target_id=user.id,
                metadata={"via": via, "has_branch": p["branch_obj"] is not None}, **ctx)
            p["password"], p["shared_password"] = password, shared
            p["status"] = "أُنشئ" if p["branch_obj"] else "أُنشئ بلا فرع"
            created += 1
    return created


def template_workbook():
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "الموظفون"
    ws.sheet_view.rightToLeft = True
    ws.append(TEMPLATE_HEADER)
    ws.append(["أحمد محمد العتيبي", "a.alotaibi", "فرع الرياض", "", ""])
    for col, width in zip("ABCDE", (30, 24, 30, 30, 24)):
        ws.column_dimensions[col].width = width
    return wb
