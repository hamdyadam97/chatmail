"""The executive (مدير تنفيذي) issues group-wide announcements and follows
their acknowledgement (user decision). Scope still comes from the role
assignment: a central executive may target every institute."""
from django.db import migrations

ADDED = ["announcements.publish", "announcements.track_ack"]


def grant(apps, schema_editor):
    Permission = apps.get_model("authorization", "Permission")
    Role = apps.get_model("authorization", "Role")
    RolePermission = apps.get_model("authorization", "RolePermission")
    role = Role.objects.filter(code="executive").first()
    if role is None:
        return
    for perm in Permission.objects.filter(code__in=ADDED):
        RolePermission.objects.get_or_create(role=role, permission=perm)


def revoke(apps, schema_editor):
    RolePermission = apps.get_model("authorization", "RolePermission")
    RolePermission.objects.filter(role__code="executive", permission__code__in=ADDED).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("authorization", "0002_seed_permissions"),
    ]

    operations = [
        migrations.RunPython(grant, revoke),
    ]
