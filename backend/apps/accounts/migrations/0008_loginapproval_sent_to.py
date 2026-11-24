from django.db import migrations, models


def mark_existing_as_admin(apps, schema_editor):
    # Before this release every code went to the administrators.
    apps.get_model("accounts", "LoginApproval").objects.update(sent_to="admin")


class Migration(migrations.Migration):
    dependencies = [("accounts", "0007_user_purged_at")]

    operations = [
        migrations.AddField(
            model_name="loginapproval",
            name="sent_to",
            field=models.CharField(blank=True, default="", max_length=32),
        ),
        migrations.RunPython(mark_existing_as_admin, migrations.RunPython.noop),
    ]
