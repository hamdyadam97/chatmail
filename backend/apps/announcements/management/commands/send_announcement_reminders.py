"""Scheduled reminders for announcements awaiting acknowledgement.

Run from cron (or a Celery beat task once Celery is introduced), e.g. hourly:
    manage.py send_announcement_reminders
Each un-acknowledged recipient is reminded at most once per 24 h, starting
24 h before the deadline. Reminders are generic notifications (no content).
"""
from django.core.management.base import BaseCommand

from apps.announcements.services import send_due_reminders


class Command(BaseCommand):
    help = "Remind recipients of announcements whose acknowledgement deadline is near or past."

    def handle(self, *args, **options):
        count = send_due_reminders()
        self.stdout.write(f"reminded {count} recipient(s)")
