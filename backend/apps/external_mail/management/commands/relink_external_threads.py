"""Group old external replies with the message they answer (by a reply
subject "Re: …" and the same address, last 60 days) and refresh every
message's conversation id. Idempotent; deploy.sh runs it on each update."""
from django.core.management.base import BaseCommand

from apps.external_mail.services import relink_threads


class Command(BaseCommand):
    help = "Link old external replies into their conversations."

    def handle(self, *args, **options):
        linked = relink_threads()
        self.stdout.write(f"linked {linked} replies")
