"""Seed the permission catalog (docs/phase1/05-permissions-design.md §5.2)
and the initial roles with their role_permissions (§5.5).

Duty separation (§5.5): sys_admin holds accounts.* but NOT roles.manage;
hr_admin holds roles.manage but NOT accounts.manage_users.
The §5.2 negative catalog is enforced by SEC-14 static tests — never add
permissions here that bypass derived content access.
"""
from django.db import migrations

# (code, name_ar, description, category)
PERMISSIONS = [
    ("org.manage_structure", "إدارة الهيكل التنظيمي", "إضافة/تعديل معاهد وفروع وأقسام، نقل موظفين", "org"),
    ("accounts.manage_users", "إدارة الحسابات", "إنشاء/تعطيل حسابات، إعادة تعيين كلمة المرور (دخول فقط)", "accounts"),
    ("accounts.manage_sessions", "إدارة الجلسات", "إلغاء جلسات مستخدم (أمان تشغيلي — لا يفتح محتوى)", "accounts"),
    ("roles.manage", "إسناد الأدوار", "إسناد أدوار وصلاحيات (مركزي فقط)", "org"),
    ("correspondence.send", "إرسال مراسلات رسمية", "إرسال مراسلات رسمية", "correspondence"),
    ("correspondence.read_participant", "قراءة مشاركة مصرح بها", "تُشتق من المشاركة — لا تُمنح يدويًا", "correspondence"),
    ("chat.use", "المحادثات والقنوات", "محادثات وقنوات", "chat"),
    ("announcements.publish", "إصدار تعاميم", "إصدار تعاميم", "org"),
    ("announcements.track_ack", "متابعة اطلاع التعاميم", "متابعة اطلاع/إقرار تعاميم", "org"),
    ("approvals.act", "قرار اعتماد", "اتخاذ قرار اعتماد مُسند إليه", "approvals"),
    ("approvals.define", "تعريف مسارات موافقات", "تعريف مسارات موافقات", "approvals"),
    ("archive.personal.use", "أرشفة شخصية", "أرشفة شخصية", "archive"),
    ("archive.institutional.access", "وصول أرشيف مؤسسي", "طلب/عرض نسخة مؤسسية مصرح بها", "archive"),
    ("reports.view_metadata", "تقارير إحصائية", "تقارير إحصائية (عدادات/أزمنة، بلا محتوى/عناوين)", "reports"),
    ("audit.view", "عرض سجل التدقيق", "عرض سجل التدقيق", "audit"),
    ("devices.review_own", "إدارة أجهزتي", "عرض وإدارة أجهزتي والإبطال", "accounts"),
    ("security.manage_transparency", "عمليات سجل الشفافية", "عمليات سجل الشفافية", "audit"),
]

_BASE = [
    "correspondence.send",
    "correspondence.read_participant",
    "chat.use",
    "archive.personal.use",
    "devices.review_own",
]
_MID = _BASE + [
    "announcements.publish",
    "announcements.track_ack",
    "approvals.act",
    "approvals.define",
]
_MANAGER = _MID + ["org.manage_structure", "reports.view_metadata"]

# (code, name_ar, permission codes)
ROLES = [
    ("employee", "موظف", _BASE),
    ("dept_head", "رئيس قسم", _MID),
    ("branch_manager", "مدير فرع", _MANAGER),
    ("institute_manager", "مدير معهد", _MANAGER),
    ("executive", "مدير تنفيذي", _BASE + ["reports.view_metadata"]),
    (
        "sys_admin",
        "مدير النظام",
        [
            "org.manage_structure",
            "accounts.manage_users",
            "accounts.manage_sessions",
            "correspondence.send",
            "correspondence.read_participant",
            "chat.use",
            "archive.personal.use",
            "devices.review_own",
        ],
    ),
    ("security_auditor", "مسؤول أمن/مراقب", ["audit.view", "security.manage_transparency", "accounts.manage_sessions"]),
    (
        "archive_officer",
        "ضابط الأرشيف المؤسسي",
        _BASE + ["archive.institutional.access"],
    ),
    ("hr_admin", "مسؤول موارد بشرية", ["roles.manage"]),
]


def seed(apps, schema_editor):
    Permission = apps.get_model("authorization", "Permission")
    Role = apps.get_model("authorization", "Role")
    RolePermission = apps.get_model("authorization", "RolePermission")

    perms = {}
    for code, name_ar, description, category in PERMISSIONS:
        perm, _ = Permission.objects.get_or_create(
            code=code,
            defaults={"name_ar": name_ar, "description": description, "category": category},
        )
        perms[code] = perm

    for code, name_ar, permission_codes in ROLES:
        role, _ = Role.objects.get_or_create(
            code=code, defaults={"name_ar": name_ar, "is_system": True}
        )
        for perm_code in permission_codes:
            RolePermission.objects.get_or_create(role=role, permission=perms[perm_code])


def unseed(apps, schema_editor):
    RolePermission = apps.get_model("authorization", "RolePermission")
    Role = apps.get_model("authorization", "Role")
    Permission = apps.get_model("authorization", "Permission")
    RolePermission.objects.all().delete()
    Role.objects.filter(code__in=[code for code, _, _ in ROLES]).delete()
    Permission.objects.filter(code__in=[code for code, _, _, _ in PERMISSIONS]).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("authorization", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
