"""Change an account's login name, keeping everything else (mail, chats,
roles, password, sessions, audit history — all tied to the account id).

    manage.py rename_user it.admin hamdy.adam          # shows what changes
    manage.py rename_user it.admin hamdy.adam --apply  # does it

The external address follows the login name unless the mailbox has its own
local part, so mail to the OLD address stops arriving (Postfix's recipient
map refreshes within minutes). Audited as username_changed.
"""
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.accounts.employee_import import USERNAME_RE
from apps.accounts.models import User
from apps.audit.services import log


class Command(BaseCommand):
    help = "Rename a user's login name (dry run unless --apply)."

    def add_arguments(self, parser):
        parser.add_argument("old")
        parser.add_argument("new")
        parser.add_argument("--apply", action="store_true", help="really rename")

    def handle(self, *args, old, new, apply, **opts):
        from apps.external_mail.models import ExternalMailbox
        from apps.external_mail.services import LOCAL_PART_RE, address_for, mailbox_for

        new = new.strip()
        user = User.objects.filter(username=old).first()
        if user is None:
            raise CommandError(f"no user {old!r}")
        if not USERNAME_RE.match(new):
            raise CommandError("the new name may use letters, digits, dot, dash and underscore only")
        if User.objects.filter(username__iexact=new).exclude(id=user.id).exists():
            raise CommandError(f"{new!r} is already another account — rename or deactivate that one first")
        if ExternalMailbox.objects.filter(local_part__iexact=new).exclude(user=user).exists():
            raise CommandError(f"{new!r} is already another employee's external address")

        old_address = address_for(user)
        own_local_part = bool(mailbox_for(user).local_part)
        self.stdout.write(f"login name: {old} -> {new}")
        if own_local_part:
            self.stdout.write(f"external address unchanged: {old_address}")
        elif LOCAL_PART_RE.match(new.lower()):
            self.stdout.write(f"external address: {old_address} -> (new) {new.lower()}@...  — mail to the old one stops")
        if not apply:
            self.stdout.write("dry run — add --apply to rename")
            return

        with transaction.atomic():
            user.username = new
            user.save(update_fields=["username", "updated_at"])
            log(actor=user, action="username_changed", target_type="user", target_id=user.id,
                metadata={"old": old, "new": new, "via": "manage.py rename_user"})
        self.stdout.write(self.style.SUCCESS(f"renamed. external address now: {address_for(user)}"))
