"""One temporary password for every account that has not logged in yet.

    manage.py set_temp_password                 # dry run: who would change
    manage.py set_temp_password --apply         # asks for the password (twice)

Only accounts that never logged in and still must change their password
(e.g. the imported staff) are touched; administrators and anyone already
using the system are left alone. The password is read from the terminal,
never from the command line (shell history), and is not printed or logged.
Each account must still change it at first login, and a first login from a
new browser still needs the administrator's code.
"""
from getpass import getpass

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.accounts.models import User
from apps.accounts.password_policy import validate_password_policy
from apps.audit.services import log


class Command(BaseCommand):
    help = "Set one temporary password on accounts that never logged in (dry run unless --apply)."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="really set the password")
        parser.add_argument("--by", default="it.admin", help="administrator recorded in the audit log")

    def handle(self, *args, **opts):
        admin = User.objects.filter(username=opts["by"]).first()
        if admin is None:
            raise CommandError(f"no user {opts['by']!r} (use --by)")
        users = list(
            User.objects.filter(is_active=True, last_login_at__isnull=True, must_change_password=True)
            .exclude(id=admin.id).order_by("username")
        )
        self.stdout.write(f"{len(users)} account(s) never logged in and must change their password")
        if not opts["apply"]:
            self.stdout.write("dry run — nothing written (add --apply)")
            return
        if not users:
            return

        password = getpass("Temporary password: ")
        if password != getpass("Again: "):
            raise CommandError("the two entries differ")
        skipped = []
        for u in users:
            try:
                validate_password_policy(u.username, password)
            except ValidationError as exc:
                if len(password) < 10:
                    raise CommandError("the password must be at least 10 characters") from exc
                skipped.append(u.username)
        now = timezone.now()
        done = 0
        with transaction.atomic():
            for u in users:
                if u.username in skipped:
                    continue
                u.set_password(password)
                u.password_changed_at = now
                u.save(update_fields=["password", "password_changed_at", "updated_at"])
                log(actor=admin, action="password_reset", target_type="user", target_id=u.id,
                    metadata={"via": "set_temp_password"})
                done += 1
        for name in skipped:
            self.stdout.write(f"      skipped {name}: the password contains the username")
        self.stdout.write(self.style.SUCCESS(f"set on {done} account(s); each must change it at first login"))
