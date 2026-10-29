"""Authorization engine (docs/phase1/05-permissions-design.md §5.1).

has_permission(user, code, unit=None) checks:
  1. the user holds an active (non-expired) role assignment whose role
     includes the permission, and
  2. the assignment's organizational scope covers the requested unit:
     - all scope FKs NULL = central/general (matches only when unit=None)
     - institute scope matches any unit inside that institute
     - branch scope matches the branch and its departments
     - department scope matches that exact department only
"""
from django.db.models import Q
from django.utils import timezone

from apps.org.models import Branch, Department, Institute

from .models import UserRoleAssignment


def unit_lineage(unit):
    """(institute_id, branch_id, department_id) for an org unit instance."""
    if unit is None:
        return (None, None, None)
    if isinstance(unit, Department):
        return (unit.institute_id, unit.branch_id, unit.pk)
    if isinstance(unit, Branch):
        return (unit.institute_id, unit.pk, None)
    if isinstance(unit, Institute):
        return (unit.pk, None, None)
    raise TypeError(f"Unsupported unit type: {type(unit)!r}")


def active_assignments(user):
    now = timezone.now()
    return (
        UserRoleAssignment.objects.filter(user=user)
        .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=now))
        .select_related("role", "institute", "branch", "department")
    )


DEFAULT_ROLE = "employee"


def grant_default_role(user, institute, *, granted_by, request=None):
    """Give an employee the base `employee` role in their primary institute
    (user decision: every staff member is an employee). No-op when the user
    already holds it there. Audited like a manual grant."""
    from apps.audit.services import log, request_context

    from .models import Role

    role = Role.objects.filter(code=DEFAULT_ROLE).first()
    if role is None or active_assignments(user).filter(role=role, institute=institute).exists():
        return None
    assignment = UserRoleAssignment.objects.create(
        user=user, role=role, institute=institute, granted_by=granted_by
    )
    log(
        actor=granted_by,
        action="permission_granted",
        target_type="user_role_assignment",
        target_id=assignment.id,
        org_scope=institute.code,
        **request_context(request),
        metadata={
            "user": user.username,
            "role": role.code,
            "scope": {"institute": institute.code, "branch": None, "department": None},
            "automatic": True,
        },
    )
    return assignment


def has_permission(user, code, unit=None) -> bool:
    """True iff an active assignment grants `code` within `unit`'s subtree.

    unit=None requires a central assignment (all scope FKs NULL).
    """
    if user is None:
        return False
    if not getattr(user, "is_authenticated", False):
        return False
    if not getattr(user, "is_active", False):
        return False

    if unit is None:
        inst_u = br_u = dept_u = None
    else:
        inst_u, br_u, dept_u = unit_lineage(unit)

    assignments = active_assignments(user).filter(
        role__role_permissions__permission__code=code
    )
    for assignment in assignments.iterator():
        if assignment.institute_id is not None and assignment.institute_id != inst_u:
            continue
        if assignment.branch_id is not None and assignment.branch_id != br_u:
            continue
        if assignment.department_id is not None and assignment.department_id != dept_u:
            continue
        return True
    return False


def get_user_roles(user):
    """Distinct roles held by the user through active assignments."""
    if user is None or not getattr(user, "is_authenticated", False):
        return []
    from .models import Role

    return Role.objects.filter(
        assignments__user=user,
    ).filter(
        Q(assignments__expires_at__isnull=True) | Q(assignments__expires_at__gt=timezone.now())
    ).distinct()


def user_scope_summary(user) -> list[dict]:
    """Human-readable active assignments (used by /users/me/)."""
    return [
        {
            "role": a.role.code,
            "institute": a.institute.code if a.institute_id else None,
            "branch": a.branch.code if a.branch_id else None,
            "department": a.department.code if a.department_id else None,
            "expires_at": a.expires_at,
        }
        for a in active_assignments(user)
    ]
