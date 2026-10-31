"""Pending new-browser login codes, for root on the server — the way in when
no administrator can be reached (e.g. the administrator's own new browser
and no e-mail configured).

    manage.py login_codes [--user USERNAME]
"""
from django.core.management.base import BaseCommand

from apps.accounts import login_approval
from apps.audit.services import log


class Command(BaseCommand):
    help = "Show pending new-browser login codes (server console only)."

    def add_arguments(self, parser):
        parser.add_argument("--user", help="only this username")

    def handle(self, *args, **options):
        rows = login_approval.pending()
        if options["user"]:
            rows = rows.filter(user__username=options["user"])
        rows = list(rows)
        if not rows:
            self.stdout.write("no pending login codes")
            return
        for a in rows:
            self.stdout.write(
                f"{a.user.username}\t{login_approval.code_of(a)}\t{a.device_label}\t"
                f"{a.created_at:%Y-%m-%d %H:%M}\tuntil {a.expires_at:%H:%M}"
            )
            log(actor=None, action="login_code_shown_on_server", target_type="user", target_id=a.user_id,
                metadata={"approval_id": str(a.id)})
