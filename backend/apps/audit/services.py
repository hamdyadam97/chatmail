"""Audit logging helper — the single entry point for writing audit rows.

NEVER pass secrets (passwords, OTPs, temp passwords, keys, plaintext) in
any field here; metadata must contain identifiers/counters only. SEC-10
tests run canary scenarios against this contract.
"""
from typing import Any

from .models import AuditLog


def log(
    *,
    actor=None,
    actor_device=None,
    action: str,
    target_type: str = "",
    target_id=None,
    org_scope: str = "",
    ip=None,
    user_agent: str = "",
    metadata: dict | None = None,
) -> AuditLog:
    """Append one audit row. All arguments except `action` are optional."""
    return AuditLog.objects.log(
        actor=actor if getattr(actor, "is_authenticated", True) else None,
        actor_device=actor_device,
        action=action,
        target_type=target_type,
        target_id=target_id,
        org_scope=org_scope,
        ip=ip,
        user_agent=(user_agent or "")[:512],
        metadata=metadata or {},
    )


def client_ip(request) -> str | None:
    """Best-effort client IP from a DRF/Django request."""
    if request is None:
        return None
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        return forwarded.split(",")[0].strip() or None
    return request.META.get("REMOTE_ADDR")


def request_context(request) -> dict[str, Any]:
    """Convenience: pull ip/user_agent from a request for audit.log()."""
    return {
        "ip": client_ip(request),
        "user_agent": request.META.get("HTTP_USER_AGENT", "") if request is not None else "",
    }


def primary_org_scope(user) -> str:
    """Short scope descriptor for a user's primary membership (e.g. 'AHL')."""
    if user is None or not getattr(user, "is_authenticated", False):
        return ""
    membership = user.memberships.filter(is_primary=True).select_related("institute").first()
    if membership and membership.institute_id:
        return membership.institute.code
    return ""
