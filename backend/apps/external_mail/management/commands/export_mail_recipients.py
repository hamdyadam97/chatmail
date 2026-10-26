"""Write the Postfix recipient map (every address that may receive), so
unknown addresses are rejected during the SMTP dialogue instead of bouncing
afterwards (no backscatter). Run by a systemd timer, then `postmap`."""
from pathlib import Path

from django.core.management.base import BaseCommand

from apps.external_mail import services


class Command(BaseCommand):
    help = "Export the external mail recipient map for Postfix."

    def add_arguments(self, parser):
        parser.add_argument("--output", required=True)

    def handle(self, *args, output, **options):
        lines = services.recipients_map_lines()
        path = Path(output)
        tmp = path.with_suffix(".tmp")
        tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        tmp.replace(path)
        self.stdout.write(f"{len(lines)} address(es)")
