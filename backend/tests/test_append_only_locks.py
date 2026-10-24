"""Append-only tables are INSERT/SELECT-only for the runtime role in
PostgreSQL (deploy/postgres/grants.sql). PostgreSQL requires UPDATE privilege
for SELECT ... FOR UPDATE, so locking those tables fails in production with
"permission denied" — while SQLite (the test database) silently ignores FOR
UPDATE. This static check is the only place the mistake can be caught.
"""
import re
from pathlib import Path

APPS = Path(__file__).resolve().parents[1] / "apps"
APPEND_ONLY_MODELS = ("KeyTransparencyEvent", "AuditLog")


def test_no_row_locks_on_append_only_tables():
    offenders = []
    for path in APPS.rglob("*.py"):
        if "migrations" in path.parts:
            continue
        source = path.read_text(encoding="utf-8")
        for model in APPEND_ONLY_MODELS:
            # a statement starting at Model.objects ... up to the closing paren chain
            for match in re.finditer(rf"{model}\.objects(?:[^\n]|\n\s+\.)*", source):
                if "select_for_update" in match.group(0):
                    line = source[: match.start()].count("\n") + 1
                    offenders.append(f"{path.relative_to(APPS)}:{line}")
    assert not offenders, f"select_for_update on an append-only table: {offenders}"
