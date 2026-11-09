"""The assignable roles and the scope each one takes (user decision,
2026-11-08 — see migration 0004_five_roles). Other roles in the table are
legacy: existing assignments still resolve, but nobody can be given them."""

# code -> scope kind
ASSIGNABLE = {
    "employee": "institute",        # automatic on account creation (grant_default_role)
    "branch_manager": "branch",     # exactly one branch
    "regional_manager": "branches",  # one assignment per branch the admin picks
    "executive": "central",
    "sys_admin": "central",
}
ORDER = list(ASSIGNABLE)

SCOPE_ERRORS = {
    "institute": "دور الموظف يُسند على معهد.",
    "branch": "مدير الفرع يُسند على فرع واحد.",
    "branches": "المدير الإقليمي يُسند على فروع محددة.",
    "central": "هذا الدور مركزي — بلا معهد أو فرع.",
}


def scope_ok(kind: str, *, institute, branch, department) -> bool:
    if department is not None:
        return False
    if kind == "central":
        return institute is None and branch is None
    if kind == "institute":
        return institute is not None and branch is None
    return branch is not None  # branch / branches
