"""Accounts imported from Excel kept the whole name in first_name. Split it
into first name (first word) + family name (the rest) so the admin can edit
both; full_name — what everyone sees — is unchanged."""
from django.db import migrations


def split(apps, schema_editor):
    User = apps.get_model("accounts", "User")
    for u in User.objects.filter(last_name="").exclude(first_name="").only("id", "first_name"):
        parts = u.first_name.split()
        if len(parts) > 1:
            User.objects.filter(id=u.id).update(first_name=parts[0], last_name=" ".join(parts[1:]))


class Migration(migrations.Migration):
    dependencies = [("accounts", "0005_login_approvals")]
    operations = [migrations.RunPython(split, migrations.RunPython.noop)]
