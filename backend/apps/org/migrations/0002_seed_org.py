"""Seed the organization group and its five institutes
(docs/phase1/AGENTS.md: الأهلي، الفاو، الثقة الدائمة، المورد الوافي، آفاق التطور).
"""
from django.db import migrations

INSTITUTES = [
    ("الأهلي", "AHL"),
    ("الفاو", "FAW"),
    ("الثقة الدائمة", "THQ"),
    ("المورد الوافي", "MWR"),
    ("آفاق التطور", "AFQ"),
]


def seed(apps, schema_editor):
    Organization = apps.get_model("org", "Organization")
    Institute = apps.get_model("org", "Institute")
    org, _ = Organization.objects.get_or_create(
        slug="institutes-group",
        defaults={"name": "مجموعة المعاهد", "is_active": True},
    )
    for name, code in INSTITUTES:
        Institute.objects.get_or_create(code=code, defaults={"organization": org, "name": name})


def unseed(apps, schema_editor):
    Institute = apps.get_model("org", "Institute")
    Organization = apps.get_model("org", "Organization")
    Institute.objects.filter(code__in=[code for _, code in INSTITUTES]).delete()
    Organization.objects.filter(slug="institutes-group").delete()


class Migration(migrations.Migration):
    dependencies = [
        ("org", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
