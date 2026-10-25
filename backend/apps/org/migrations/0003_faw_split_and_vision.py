"""Institutes per the group's logos (user decision, 2026-10-25):
الفاو is two institutes — المتقدم (existing FAW) and التخصصي (new FAS) — and
Vision 3020 joins the group (VSN). Existing names are only touched when still
the seeded default, so edits made from the admin pages are kept.
"""
from django.db import migrations

NEW = [("الفاو التخصصي", "FAS"), ("Vision 3020 للتدريب", "VSN")]


def forward(apps, schema_editor):
    Organization = apps.get_model("org", "Organization")
    Institute = apps.get_model("org", "Institute")
    org = Organization.objects.filter(slug="institutes-group").first()
    if org is None:
        return
    Institute.objects.filter(code="FAW", name="الفاو").update(name="الفاو المتقدم")
    for name, code in NEW:
        Institute.objects.get_or_create(code=code, defaults={"organization": org, "name": name})


def backward(apps, schema_editor):
    # Institutes may already carry memberships and reference numbers: never delete them here.
    pass


class Migration(migrations.Migration):
    dependencies = [("org", "0002_seed_org")]
    operations = [migrations.RunPython(forward, backward)]
