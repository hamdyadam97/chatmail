"""Create the first administrator(s) on a fresh production install.

    manage.py bootstrap_admin --username it.admin --first-name محمد --last-name الأحمد \
        --institute AHL [--branch RYD] --role sys_admin [--role security_auditor]

Prints a temporary password ONCE (must be changed at first login). Unlike
seed_demo there are no known passwords. Separation of duties (docs/phase1/05
§5.5): one person may not hold both roles.manage and accounts.manage_users
unless --allow-combined-duties is given explicitly.

Login administration only — no crypto material is created or touched here
(the user bootstraps their own device identity at first login, SEC-08).
"""
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.accounts.password_policy import generate_temp_password
from apps.audit.services import log
from apps.authorization.models import Role, UserRoleAssignment
from apps.org.models import Branch, EmployeeMembership, Institute


class Command(BaseCommand):
    help = "Create an administrator account with a one-time temporary password."

    def add_arguments(self, parser):
        parser.add_argument("--username", required=True)
        parser.add_argument("--first-name", default="")
        parser.add_argument("--last-name", default="")
        parser.add_argument("--institute", required=True, help="institute code, e.g. AHL")
        parser.add_argument("--branch", help="branch code within the institute")
        parser.add_argument("--job-title", default="مسؤول النظام")
        parser.add_argument("--role", action="append", required=True, help="role code; repeatable")
        parser.add_argument("--allow-combined-duties", action="store_true")

    def handle(self, *args, **o):
        if User.objects.filter(username=o["username"]).exists():
            raise CommandError(f"user {o['username']!r} already exists")
        institute = Institute.objects.filter(code=o["institute"]).first()
        if institute is None:
            raise CommandError(f"unknown institute code {o['institute']!r}")
        branch = None
        if o.get("branch"):
            branch = Branch.objects.filter(institute=institute, code=o["branch"]).first()
            if branch is None:
                raise CommandError(f"unknown branch {o['branch']!r} in {institute.code}")
        roles = list(Role.objects.filter(code__in=o["role"]).prefetch_related("role_permissions__permission"))
        missing = set(o["role"]) - {r.code for r in roles}
        if missing:
            raise CommandError(f"unknown role(s): {', '.join(sorted(missing))}")
        perms = {rp.permission.code for r in roles for rp in r.role_permissions.all()}
        if {"roles.manage", "accounts.manage_users"} <= perms and not o["allow_combined_duties"]:
            raise CommandError(
                "roles.manage and accounts.manage_users on the same person breaks separation of duties; "
                "create two administrators, or pass --allow-combined-duties deliberately."
            )

        temp = generate_temp_password(o["username"])
        with transaction.atomic():
            user = User(
                username=o["username"],
                first_name=o["first_name"],
                last_name=o["last_name"],
                full_name=f"{o['first_name']} {o['last_name']}".strip() or o["username"],
                must_change_password=True,
            )
            user.set_password(temp)
            user.save()
            EmployeeMembership.objects.create(
                user=user, institute=institute, branch=branch, job_title=o["job_title"],
                is_primary=True, started_on=timezone.localdate(),
            )
            for role in roles:
                UserRoleAssignment.objects.create(user=user, role=role)  # central scope
        log(action="account_bootstrapped", target_type="user", target_id=user.id,
            metadata={"roles": sorted(r.code for r in roles)})
        self.stdout.write(f"created {user.username} with roles: {', '.join(sorted(r.code for r in roles))}")
        self.stdout.write(f"temporary password (shown once, change at first login): {temp}")
