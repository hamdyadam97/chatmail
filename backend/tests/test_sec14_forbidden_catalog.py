"""SEC-14: the §5.2 negative catalog must not exist anywhere.

Two layers:
  1. DB catalog: no permission code matches forbidden identifiers.
  2. Static source scan of backend/ (apps, config, migrations) for the
     forbidden identifiers — this is the CI check from doc 07.

The test files themselves legitimately contain the forbidden strings as
patterns, so backend/tests/ is excluded from the scan (the CI scan should
do the same, or use word-boundary allowlisting).
"""
import re
from pathlib import Path

import pytest

from apps.authorization.models import Permission

pytestmark = pytest.mark.django_db

FORBIDDEN = [
    "view_all_messages",
    "view_all_employee_mailboxes",
    "view_all_branch_correspondences",
    "decrypt_all_messages",
    "master_key",
    "master key",
    "escrow",
]

BACKEND_ROOT = Path(__file__).resolve().parent.parent


def test_catalog_has_no_forbidden_permissions():
    codes = set(Permission.objects.values_list("code", flat=True))
    assert len(codes) == 17  # the full §5.2 catalog
    for code in codes:
        lowered = code.lower()
        assert "view_all" not in lowered, code
        assert "decrypt_all" not in lowered, code


def test_no_role_in_catalog_grants_content_bypass():
    """Even the most privileged seeded role must hold no content-bypass code."""
    from apps.authorization.models import Role

    for role in Role.objects.prefetch_related("role_permissions__permission"):
        for rp in role.role_permissions.all():
            assert not any(f in rp.permission.code for f in FORBIDDEN), (
                f"{role.code} grants forbidden {rp.permission.code}"
            )


def test_source_scan_for_forbidden_identifiers():
    offenders = []
    for path in BACKEND_ROOT.rglob("*.py"):
        rel = path.relative_to(BACKEND_ROOT)
        if rel.parts[0] == "tests":
            continue
        text = path.read_text(encoding="utf-8")
        for needle in FORBIDDEN:
            if re.search(re.escape(needle), text, flags=re.IGNORECASE):
                offenders.append(f"{rel}: {needle}")
    assert offenders == [], "Forbidden identifiers found:\n" + "\n".join(offenders)
