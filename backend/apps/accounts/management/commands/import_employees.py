"""Bulk-create employee accounts from the HR spreadsheet.

    manage.py import_employees FILE.xlsx                 # dry run: report only
    manage.py import_employees FILE.xlsx --apply --out /root/passwords.xlsx

The rules (columns, skipped rows, branches, passwords) live in
apps.accounts.employee_import, shared with the employees page.

The --out file holds the temporary passwords: it is written 0600 and must be
handed out and deleted. Nothing is written in a dry run.
"""
import os
from collections import Counter

from django.core.management.base import BaseCommand, CommandError

from apps.accounts import employee_import as imp
from apps.accounts.models import User


class Command(BaseCommand):
    help = "Import employees from the HR spreadsheet (dry run unless --apply)."

    def add_arguments(self, parser):
        parser.add_argument("file")
        parser.add_argument("--apply", action="store_true", help="really create the accounts")
        parser.add_argument("--out", default="", help="xlsx report with the temporary passwords")
        parser.add_argument("--by", default="it.admin", help="administrator recorded as the creator")
        parser.add_argument("--include-test", action="store_true", help="also import rows marked as test accounts")
        parser.add_argument("--create-branches", action="store_true",
                            help="create missing branches under the row's institute (code from the city)")

    def handle(self, *args, **opts):
        admin = User.objects.filter(username=opts["by"]).first()
        if admin is None:
            raise CommandError(f"no user {opts['by']!r} (use --by)")
        if opts["apply"] and not opts["out"]:
            raise CommandError("--apply needs --out (the temporary passwords go there)")
        try:
            with open(opts["file"], "rb") as fh:
                records = imp.read_records(fh)
        except imp.ImportError_ as exc:
            raise CommandError(str(exc))

        plan, new_branches = imp.plan(records, include_test=opts["include_test"],
                                      create_branches=opts["create_branches"])
        for status, n in Counter(p["status"] for p in plan).most_common():
            self.stdout.write(f"{n:4d}  {status}")
        for name, n in Counter(p["branch"] for p in plan if p["status"] == "الفرع غير موجود في النظام").most_common():
            self.stdout.write(f"      فرع غير موجود: {name} ({n})")
        for b in new_branches.values():
            if b._state.adding:
                self.stdout.write(f"      فرع جديد: {b.institute.code}-{b.code}  {b.name}  (معهد {b.institute.name})")
        if not opts["apply"]:
            self.stdout.write("dry run — nothing written (add --apply --out FILE)")
            return

        created = imp.apply(plan, new_branches, admin=admin, via="import_employees")
        self._write_report(opts["out"], plan)
        self.stdout.write(self.style.SUCCESS(f"created {created} account(s); report: {opts['out']} (delete it after use)"))

    @staticmethod
    def _write_report(path, plan):
        import openpyxl

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "الحسابات"
        ws.sheet_view.rightToLeft = True
        ws.append(["الاسم", "اسم المستخدم", "كلمة المرور المؤقتة", "الفرع", "الحالة"])
        for p in plan:
            # every cell as text (no formula injection from names)
            ws.append([f"{v}" for v in (p["name"], p["username"], p.get("password", ""), p["branch"], p["status"])])
            for cell in ws[ws.max_row]:
                cell.data_type = "s"
        for col, width in zip("ABCDE", (30, 34, 20, 36, 30)):
            ws.column_dimensions[col].width = width
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            wb.save(fh)
