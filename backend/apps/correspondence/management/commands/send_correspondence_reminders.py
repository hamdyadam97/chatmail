"""Scheduled due-date reminders for official correspondence.

Run hourly (systemd timer correspondence-reminders), e.g.:
    manage.py send_correspondence_reminders
Each waiting primary recipient is reminded once when the due date is today
or tomorrow, and once more after it passes; the sender is told once that the
correspondence went past its due date unanswered. Generic notifications only.
"""
from django.core.management.base import BaseCommand

from apps.correspondence.services import send_due_reminders


class Command(BaseCommand):
    help = "Remind recipients (and senders) of correspondence whose due date is near or past."

    def handle(self, *args, **options):
        c = send_due_reminders()
        self.stdout.write(
            f"due soon: {c['due_soon']} | overdue: {c['overdue']} | senders told: {c['overdue_sender']}"
        )
