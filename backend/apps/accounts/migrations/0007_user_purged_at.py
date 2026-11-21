from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("accounts", "0006_split_imported_names")]

    operations = [
        migrations.AddField(
            model_name="user",
            name="purged_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
