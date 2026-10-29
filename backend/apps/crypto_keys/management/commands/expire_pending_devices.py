"""Withdraw device registrations left pending for more than 7 days.

Run hourly with the reminders (systemd timer correspondence-reminders):
    manage.py expire_pending_devices
"""
from django.core.management.base import BaseCommand

from apps.crypto_keys.services import expire_pending_devices


class Command(BaseCommand):
    help = "Revoke device registrations nobody approved within 7 days."

    def handle(self, *args, **options):
        self.stdout.write(f"expired pending devices: {expire_pending_devices()}")
