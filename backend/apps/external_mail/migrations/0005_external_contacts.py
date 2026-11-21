import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def backfill(apps, schema_editor):
    """Remember the addresses each owner already sent to (names unknown)."""
    Message = apps.get_model("external_mail", "ExternalMessage")
    Contact = apps.get_model("external_mail", "ExternalContact")
    seen: dict[tuple, list] = {}
    for owner_id, recipients, created_at in (
        Message.objects.filter(direction="out").order_by("created_at").values_list("owner_id", "recipients", "created_at")
    ):
        for address in recipients or []:
            key = (owner_id, str(address).strip().lower())
            if not key[1]:
                continue
            entry = seen.setdefault(key, [0, created_at])
            entry[0] += 1
            entry[1] = created_at
    Contact.objects.bulk_create(
        [Contact(owner_id=o, address=a, use_count=n, last_used_at=t) for (o, a), (n, t) in seen.items()],
        ignore_conflicts=True,
    )


class Migration(migrations.Migration):
    dependencies = [
        ("external_mail", "0004_sending_on_by_default"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="ExternalContact",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("address", models.CharField(max_length=320)),
                ("name_enc", models.BinaryField(blank=True, null=True)),
                ("use_count", models.IntegerField(default=0)),
                ("last_used_at", models.DateTimeField(blank=True, null=True)),
                (
                    "owner",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="external_contacts",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"db_table": "external_contacts"},
        ),
        migrations.AddConstraint(
            model_name="externalcontact",
            constraint=models.UniqueConstraint(fields=("owner", "address"), name="uq_ext_contact_owner_address"),
        ),
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
