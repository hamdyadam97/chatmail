"""Everyone sends external mail by default (user decision, 2026-11-08):
the default flips to on, and existing mailboxes are switched on once."""
from django.db import migrations, models


def enable(apps, schema_editor):
    apps.get_model("external_mail", "ExternalMailbox").objects.filter(sending_enabled=False).update(
        sending_enabled=True
    )


class Migration(migrations.Migration):
    dependencies = [
        ("external_mail", "0003_image_senders"),
    ]

    operations = [
        migrations.AlterField(
            model_name="externalmailbox",
            name="sending_enabled",
            field=models.BooleanField(default=True),
        ),
        migrations.RunPython(enable, migrations.RunPython.noop),
    ]
