"""Seed demo identities for the scripted end-to-end chat test.

Creates (idempotently):
  ahmed/ahmed (Ahmed@12345), mohamed/mohamed (Mohamed@12345),
  sara/sara (Sara@12345) — all members of الأهلي (RYD branch) holding the
  seeded ``employee`` role scoped to that institute (correspondence.send,
  chat.use…) — admin/admin (Admin@12345) with the seeded sys_admin role, and
  manager/manager (Manager@12345), branch_manager of AHL/RYD (publishes
  announcements; still cannot read anyone's correspondence).

MFA is intentionally left disabled so the scripted login flow is direct.
Passwords are demo-only and documented here; the password policy used by the
change-password endpoint is not applied to programmatic seeding.
"""
from datetime import date

from django.core.management.base import BaseCommand

from apps.accounts.models import User
from apps.authorization.models import Role, UserRoleAssignment
from apps.org.models import Branch, EmployeeMembership, Institute

DEMO_USERS = [
    # (username, password, first_name, last_name, job_title)
    ("ahmed", "Ahmed@12345", "أحمد", "العتيبي", "موظف"),
    ("mohamed", "Mohamed@12345", "محمد", "الشهري", "موظف"),
    ("sara", "Sara@12345", "سارة", "القحطاني", "موظفة"),
    ("admin", "Admin@12345", "مدير", "النظام", "مدير النظام"),
    ("manager", "Manager@12345", "خالد", "الدوسري", "مدير فرع الرياض"),
    ("archivist", "Archivist@12345", "نورة", "الحربي", "ضابطة الأرشيف المركزي"),
]

AHL_CODE = "AHL"
RYD_CODE = "RYD"


class Command(BaseCommand):
    help = "Seed demo users (ahmed/mohamed/sara/admin/manager/archivist) with memberships and roles."

    def handle(self, *args, **options):
        institute = Institute.objects.filter(code=AHL_CODE).first()
        if institute is None:
            self.stderr.write(
                f"Institute {AHL_CODE} not found — run migrations (org seeds) first."
            )
            return
        branch, _ = Branch.objects.get_or_create(
            institute=institute,
            code=RYD_CODE,
            defaults={"name": "فرع الرياض", "city": "الرياض"},
        )

        for username, password, first_name, last_name, job_title in DEMO_USERS:
            user, created = User.objects.get_or_create(
                username=username,
                defaults={
                    "first_name": first_name,
                    "last_name": last_name,
                    "full_name": f"{first_name} {last_name}",
                    "is_active": True,
                    "must_change_password": False,
                },
            )
            if created:
                user.set_password(password)
                user.save(update_fields=["password"])
                self.stdout.write(f"created user {username}")
            else:
                self.stdout.write(f"user {username} already exists")

            if not user.memberships.filter(is_primary=True).exists():
                EmployeeMembership.objects.create(
                    user=user,
                    institute=institute,
                    branch=branch,
                    job_title=job_title,
                    is_primary=True,
                    started_on=date(2024, 1, 1),
                )
                self.stdout.write(f"  + primary membership: {AHL_CODE}/{RYD_CODE}")

            if username != "admin":
                _, granted = UserRoleAssignment.objects.get_or_create(
                    user=user, role=Role.objects.get(code="employee"), institute=institute
                )
                if granted:
                    self.stdout.write(f"  + employee role @ {AHL_CODE}")

        manager = User.objects.get(username="manager")
        UserRoleAssignment.objects.get_or_create(
            user=manager, role=Role.objects.get(code="branch_manager"), institute=institute, branch=branch
        )

        archivist = User.objects.get(username="archivist")
        UserRoleAssignment.objects.get_or_create(user=archivist, role=Role.objects.get(code="archive_officer"))

        admin = User.objects.get(username="admin")
        role = Role.objects.get(code="sys_admin")
        _, created = UserRoleAssignment.objects.get_or_create(user=admin, role=role)
        self.stdout.write(
            "admin sys_admin role " + ("assigned" if created else "already present")
        )
