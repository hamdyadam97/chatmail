"""Where a user sits, for display next to their name (branch, else institute).

Only names of org units — the same facts the basic directory already shows to
every authenticated user.
"""
from .models import EmployeeMembership


def primary_units(user_ids) -> dict[str, dict]:
    """{str(user_id): {"branch": name|None, "institute": name}} from each
    user's primary membership; users without one are absent. One query."""
    rows = (
        EmployeeMembership.objects.filter(user_id__in=list(user_ids), is_primary=True)
        .select_related("institute", "branch")
        .only("user_id", "institute__name", "branch__name")
    )
    return {
        str(m.user_id): {
            "branch": m.branch.name if m.branch_id else None,
            "institute": m.institute.name,
        }
        for m in rows
    }


def with_units(refs: list[dict]) -> list[dict]:
    """Adds "branch" and "institute" to each {"id": ...} user ref, in place."""
    units = primary_units({r["id"] for r in refs})
    for r in refs:
        u = units.get(str(r["id"]), {})
        r["branch"] = u.get("branch")
        r["institute"] = u.get("institute")
    return refs
