"""The executive receives every announcement as an observer — including the
ones published before this change (no notification for those)."""
from django.db import migrations, models
from django.db.models import Q
from django.utils import timezone


def add_existing(apps, schema_editor):
    Assignment = apps.get_model("authorization", "UserRoleAssignment")
    Announcement = apps.get_model("announcements", "Announcement")
    Recipient = apps.get_model("announcements", "AnnouncementRecipient")
    Member = apps.get_model("messaging", "ConversationMember")
    now = timezone.now()
    executives = set(
        Assignment.objects.filter(
            role__code="executive", user__is_active=True, user__purged_at__isnull=True,
            institute__isnull=True, branch__isnull=True, department__isnull=True,
        ).filter(Q(expires_at__isnull=True) | Q(expires_at__gt=now)).values_list("user_id", flat=True)
    )
    if not executives:
        return
    for a in Announcement.objects.filter(status__in=["published", "withdrawn"]).only("id", "publisher_id", "thread_id"):
        have = set(Recipient.objects.filter(announcement_id=a.id).values_list("user_id", flat=True))
        new = [u for u in executives if u not in have and u != a.publisher_id]
        if not new:
            continue
        in_thread = set(Member.objects.filter(conversation_id=a.thread_id, user_id__in=new).values_list("user_id", flat=True))
        Member.objects.bulk_create([
            Member(conversation_id=a.thread_id, user_id=u, member_role="member", added_by_id=a.publisher_id)
            for u in new if u not in in_thread
        ])
        Recipient.objects.bulk_create([Recipient(announcement_id=a.id, user_id=u, observer=True) for u in new])


class Migration(migrations.Migration):
    dependencies = [
        ("announcements", "0003_branches_target"),
        ("authorization", "0004_five_roles"),
        ("accounts", "0009_notify_email"),
        ("messaging", "0005_server_side_content"),
    ]

    operations = [
        migrations.AddField(
            model_name="announcementrecipient",
            name="observer",
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(add_existing, migrations.RunPython.noop),
    ]
