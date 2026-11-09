"""The role model the group actually uses (user decision, 2026-11-08):

  employee          موظف          — mail, chat, external mail (everyone)
  branch_manager    مدير فرع      — + announcements to their branch, reports
  regional_manager  مدير إقليمي   — the same over the branches the admin picks
                                    (one assignment per branch)
  executive         مدير تنفيذي   — + announcements to everyone, reports
  sys_admin         مدير النظام   — controls accounts, structure, roles, audit

Managers no longer edit the structure or move staff: that stays with the
admin. The admin now also assigns roles and reads the audit log (the earlier
hr_admin / security_auditor split is dropped). Older roles stay in the table
so existing assignments keep resolving, but they are no longer assignable
(apps.authorization.roles.ASSIGNABLE).
"""
from django.db import migrations

BASE = ["correspondence.send", "correspondence.read_participant", "chat.use", "archive.personal.use",
        "devices.review_own"]
MANAGER = BASE + ["announcements.publish", "announcements.track_ack", "approvals.act", "approvals.define",
                  "reports.view_metadata"]
TARGET = {
    "employee": ("موظف", BASE),
    "branch_manager": ("مدير فرع", MANAGER),
    "regional_manager": ("مدير إقليمي", MANAGER),
    "executive": ("مدير تنفيذي", MANAGER),
    "sys_admin": ("مدير النظام", BASE + [
        "org.manage_structure", "accounts.manage_users", "accounts.manage_sessions", "roles.manage",
        "audit.view", "reports.view_metadata", "announcements.publish", "announcements.track_ack",
        "approvals.act", "approvals.define",
    ]),
}
# What each role held before this migration (for the reverse).
BEFORE = {
    "branch_manager": BASE + ["announcements.publish", "announcements.track_ack", "approvals.act",
                              "approvals.define", "org.manage_structure", "reports.view_metadata"],
    "executive": BASE + ["reports.view_metadata", "announcements.publish", "announcements.track_ack"],
    "sys_admin": ["org.manage_structure", "accounts.manage_users", "accounts.manage_sessions"] + BASE,
}


def _set(apps, code, name_ar, perm_codes):
    Permission = apps.get_model("authorization", "Permission")
    Role = apps.get_model("authorization", "Role")
    RolePermission = apps.get_model("authorization", "RolePermission")
    role, _ = Role.objects.get_or_create(code=code, defaults={"name_ar": name_ar, "is_system": True})
    if role.name_ar != name_ar:
        role.name_ar = name_ar
        role.save(update_fields=["name_ar"])
    perms = list(Permission.objects.filter(code__in=perm_codes))
    RolePermission.objects.filter(role=role).exclude(permission__in=perms).delete()
    for perm in perms:
        RolePermission.objects.get_or_create(role=role, permission=perm)


def forward(apps, schema_editor):
    for code, (name_ar, perms) in TARGET.items():
        _set(apps, code, name_ar, perms)


def backward(apps, schema_editor):
    Role = apps.get_model("authorization", "Role")
    for code, perms in BEFORE.items():
        _set(apps, code, TARGET[code][0], perms)
    Role.objects.filter(code="regional_manager", assignments__isnull=True).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("authorization", "0003_executive_publishes_announcements"),
    ]

    operations = [
        migrations.RunPython(forward, backward),
    ]
