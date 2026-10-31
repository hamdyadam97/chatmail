"""Approval workflow engine (prompt §11; docs/phase1/04-erd.md §4.2 ح).

Rules enforced here:
  * Only the sender of a SENT correspondence opens a request on it; at most
    one pending request per correspondence.
  * Every approver must be a live to/cc participant (they already read the
    correspondence) and cannot be the requester. The engine never widens
    who can read anything.
  * Steps run in order; a step of type ``all`` needs every slot approved, an
    ``any`` step needs one. Reject/return ends the request.
  * A decision is recorded server-side with the SHA-256 of the content the
    request was opened on (which version was approved). Duplicate decisions
    are impossible (UNIQUE(step, slot_user)).
  * Delegation is temporary and transfers decision authority only — the
    delegate must be a participant in their own right.
"""
import base64
import hashlib
import json
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError
from rest_framework.status import HTTP_409_CONFLICT

from apps.accounts.models import User
from apps.audit.services import log
from apps.authorization.models import UserRoleAssignment
from apps.correspondence.models import CorrespondenceParticipant
from apps.correspondence.services import can_read, correspondence_content
from apps.notifications.services import notify

from .models import (
    ApprovalDecision,
    ApprovalDelegation,
    ApprovalRequest,
    ApprovalRequestStep,
    ApprovalStepApprover,
    ApprovalWorkflow,
)

MAX_STEPS = 10
MAX_APPROVERS_PER_STEP = 20
MAX_DELEGATION = timedelta(days=90)

class Conflict(APIException):
    status_code = HTTP_409_CONFLICT
    default_detail = "conflict"
    default_code = "conflict"


def b64(raw: bytes) -> str:
    return base64.b64encode(bytes(raw)).decode("ascii")


def content_hash_of(correspondence) -> bytes:
    content = correspondence_content(correspondence) or {}
    return hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode()).digest()


# --- visibility -----------------------------------------------------------------

def get_viewable(user, request_id) -> ApprovalRequest:
    """Visible to whoever can read the correspondence (participants), and to
    nobody else — same 403 for unknown and forbidden ids."""
    req = (
        ApprovalRequest.objects.select_related("correspondence", "requested_by")
        .filter(id=request_id)
        .first()
    )
    if req is None or not can_read(user, req.correspondence):
        raise PermissionDenied("You cannot view this approval request.")
    return req


def _participant_ids(correspondence) -> set[str]:
    return {
        str(u)
        for u in CorrespondenceParticipant.objects.filter(
            correspondence=correspondence, kind__in=("to", "cc"), removed_at__isnull=True
        ).values_list("user_id", flat=True)
    }


# --- step specs --------------------------------------------------------------------

def _resolve_selector(selector: dict, correspondence) -> list[str]:
    if "user" in selector:
        return [str(selector["user"])]
    role = selector.get("role")
    scope = selector.get("scope")
    membership = correspondence.sender_membership
    filters = {"role__code": role}
    if scope == "sender_institute":
        filters.update(institute_id=membership.institute_id, branch__isnull=True, department__isnull=True)
    elif scope == "sender_branch" and membership.branch_id:
        filters.update(branch_id=membership.branch_id, department__isnull=True)
    elif scope == "sender_department" and membership.department_id:
        filters.update(department_id=membership.department_id)
    else:
        return []
    now = timezone.now()
    return [
        str(u)
        for u in UserRoleAssignment.objects.filter(**filters)
        .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=now))
        .values_list("user_id", flat=True)
        .distinct()
    ]


def validate_step_specs(steps) -> list[dict]:
    if not isinstance(steps, list) or not (1 <= len(steps) <= MAX_STEPS):
        raise ValidationError({"steps": f"بين 1 و{MAX_STEPS} خطوات."})
    out = []
    for i, step in enumerate(steps, start=1):
        step_type = step.get("type", "all")
        if step_type not in ("all", "any"):
            raise ValidationError({"steps": f"الخطوة {i}: النوع all أو any."})
        ids = [str(x) for x in step.get("approver_ids", [])]
        if not (1 <= len(ids) <= MAX_APPROVERS_PER_STEP) or len(ids) != len(set(ids)):
            raise ValidationError({"steps": f"الخطوة {i}: معتمدون غير صالحين."})
        out.append({"type": step_type, "approver_ids": ids})
    return out


def _steps_from_workflow(workflow, correspondence) -> list[dict]:
    steps = []
    for tpl in workflow.steps.order_by("step_order"):
        ids: list[str] = []
        for selector in tpl.approver_selectors:
            ids.extend(i for i in _resolve_selector(selector, correspondence) if i not in ids)
        if not ids:
            raise ValidationError({"workflow": f"تعذر تحديد معتمدي الخطوة {tpl.step_order} لهذه المراسلة."})
        steps.append({"type": tpl.step_type, "approver_ids": ids[:MAX_APPROVERS_PER_STEP]})
    return validate_step_specs(steps)


# --- create ------------------------------------------------------------------------------

def create_request(*, requester, correspondence, steps=None, workflow_id=None) -> ApprovalRequest:
    if correspondence.sender_id != requester.id:
        raise PermissionDenied("Only the sender can request approval of this correspondence.")
    if correspondence.status != "sent":
        raise ValidationError({"correspondence_id": "يجب أن تكون المراسلة مرسلة وغير مغلقة."})
    workflow = None
    if workflow_id:
        workflow = ApprovalWorkflow.objects.filter(id=workflow_id, is_active=True).first()
        if workflow is None:
            raise ValidationError({"workflow_id": "مسار غير معروف أو غير مفعّل."})
        specs = _steps_from_workflow(workflow, correspondence)
    else:
        specs = validate_step_specs(steps)

    participants = _participant_ids(correspondence)
    everyone = {uid for s in specs for uid in s["approver_ids"]}
    if str(requester.id) in everyone:
        raise ValidationError({"steps": "لا يعتمد مقدّم الطلب طلبه بنفسه."})
    outsiders = sorted(everyone - participants)
    if outsiders:
        raise ValidationError(
            {
                "steps": "كل معتمد يجب أن يكون مستلمًا (إلى/نسخة) للمراسلة ليطّلع على محتواها المشفّر.",
                "not_participants": outsiders,
            }
        )
    active = set(
        str(u) for u in User.objects.filter(id__in=everyone, is_active=True).values_list("id", flat=True)
    )
    if active != everyone:
        raise ValidationError({"steps": "معتمد غير نشط."})

    try:
        with transaction.atomic():
            req = ApprovalRequest.objects.create(
                workflow=workflow,
                workflow_version=workflow.version if workflow else None,
                correspondence=correspondence,
                content_hash=content_hash_of(correspondence),
                requested_by=requester,
            )
            for order, spec in enumerate(specs, start=1):
                step = ApprovalRequestStep.objects.create(
                    request=req,
                    step_order=order,
                    step_type=spec["type"],
                    status="active" if order == 1 else "waiting",
                )
                ApprovalStepApprover.objects.bulk_create(
                    [ApprovalStepApprover(step=step, user_id=uid) for uid in spec["approver_ids"]]
                )
            _notify_step(req, 1)
    except IntegrityError:
        raise Conflict("يوجد طلب اعتماد قائم لهذه المراسلة.")
    log(
        actor=requester,
        action="approval_requested",
        target_type="approval_request",
        target_id=req.id,
        metadata={"correspondence_id": str(correspondence.id), "steps": len(specs)},
    )
    return req


def _notify_step(req, step_order) -> None:
    step = req.steps.get(step_order=step_order)
    approvers = [str(a.user_id) for a in step.approvers.all()]
    now = timezone.now()
    delegates = [
        str(d.delegate_id)
        for d in active_delegations(now).filter(delegator_id__in=approvers)
        if can_read(d.delegate, req.correspondence)
    ]
    notify(approvers + delegates, "approval_requested", ref_type="approval_request", ref_id=req.id, actor=req.requested_by)


# --- delegation ------------------------------------------------------------------------------

def active_delegations(now=None):
    now = now or timezone.now()
    return ApprovalDelegation.objects.filter(
        revoked_at__isnull=True, starts_at__lte=now, ends_at__gt=now
    ).select_related("delegate", "delegator")


def create_delegation(*, delegator, delegate_id, starts_at, ends_at) -> ApprovalDelegation:
    delegate = User.objects.filter(id=delegate_id, is_active=True).first()
    if delegate is None or delegate.id == delegator.id:
        raise ValidationError({"delegate_id": "مفوَّض غير صالح."})
    if ends_at <= starts_at or ends_at - starts_at > MAX_DELEGATION:
        raise ValidationError({"ends_at": "مدة التفويض يجب أن تكون موجبة ولا تتجاوز 90 يومًا."})
    if ends_at <= timezone.now():
        raise ValidationError({"ends_at": "نهاية التفويض في الماضي."})
    d = ApprovalDelegation.objects.create(
        delegator=delegator, delegate=delegate, starts_at=starts_at, ends_at=ends_at
    )
    log(
        actor=delegator,
        action="approval_delegation_created",
        target_type="approval_delegation",
        target_id=d.id,
        metadata={"delegate_id": str(delegate.id), "ends_at": ends_at.isoformat()},
    )
    return d


def revoke_delegation(user, delegation_id) -> ApprovalDelegation:
    d = ApprovalDelegation.objects.filter(id=delegation_id, delegator=user).first()
    if d is None:
        raise PermissionDenied("Not your delegation.")
    if d.revoked_at is None:
        d.revoked_at = timezone.now()
        d.save(update_fields=["revoked_at"])
        log(actor=user, action="approval_delegation_revoked", target_type="approval_delegation", target_id=d.id)
    return d


# --- deciding ------------------------------------------------------------------------------------

def current_step(req):
    return req.steps.filter(step_order=req.current_step_order).first()


def available_slot(user, req, step=None):
    """(slot_user_id, delegation) the user may fill now in the active step, or None."""
    if req.status != "pending":
        return None
    step = step or current_step(req)
    if step is None or step.status != "active":
        return None
    decided = {str(u) for u in step.decisions.values_list("slot_user_id", flat=True)}
    slots = [str(u) for u in step.approvers.values_list("user_id", flat=True) if str(u) not in decided]
    if str(user.id) in slots:
        return str(user.id), None
    for d in active_delegations().filter(delegate=user, delegator_id__in=slots):
        return str(d.delegator_id), d
    return None


DECISIONS = ("approved", "rejected", "returned")


def decide(*, user, request_id, decision: str) -> ApprovalDecision:
    req = get_viewable(user, request_id)
    if decision not in DECISIONS:
        raise ValidationError({"decision": "قرار غير معروف."})
    with transaction.atomic():
        req = ApprovalRequest.objects.select_for_update().get(pk=req.pk)
        if req.status != "pending":
            raise Conflict("الطلب ليس قيد الاعتماد.")
        step = current_step(req)
        slot = available_slot(user, req, step)
        if slot is None:
            raise PermissionDenied("You are not an approver of the current step (or already decided).")
        slot_user_id, delegation = slot
        try:
            with transaction.atomic():
                row = ApprovalDecision.objects.create(
                    request=req,
                    step=step,
                    slot_user_id=slot_user_id,
                    approver=user,
                    delegation=delegation,
                    decision=decision,
                    content_hash=req.content_hash,
                )
        except IntegrityError:
            raise Conflict("سبق اتخاذ قرار في هذه الخانة.")
        _advance(req, step, row)

    log(
        actor=user,
        action="approval_decided",
        target_type="approval_request",
        target_id=req.id,
        metadata={
            "decision": row.decision,
            "step_order": step.step_order,
            "delegated": delegation is not None,
        },
    )
    return row


def _advance(req, step, decision) -> None:
    now = timezone.now()
    if decision.decision in ("rejected", "returned"):
        step.status = decision.decision
        step.save(update_fields=["status"])
        req.steps.filter(status="waiting").update(status="cancelled")
        req.status = decision.decision
        req.decided_at = now
        req.save(update_fields=["status", "decided_at"])
        notify([req.requested_by_id], "approval_decided", ref_type="approval_request", ref_id=req.id, actor=decision.approver)
        return
    approved_slots = step.decisions.filter(decision="approved").count()
    if step.step_type == "all" and approved_slots < step.approvers.count():
        return
    step.status = "approved"
    step.save(update_fields=["status"])
    nxt = req.steps.filter(step_order=step.step_order + 1).first()
    if nxt is not None:
        nxt.status = "active"
        nxt.save(update_fields=["status"])
        req.current_step_order = nxt.step_order
        req.save(update_fields=["current_step_order"])
        _notify_step(req, nxt.step_order)
        return
    req.status = "approved"
    req.decided_at = now
    req.save(update_fields=["status", "decided_at"])
    notify([req.requested_by_id], "approval_decided", ref_type="approval_request", ref_id=req.id, actor=decision.approver)


# --- requester actions ---------------------------------------------------------------------------

def cancel_request(user, req) -> ApprovalRequest:
    if req.requested_by_id != user.id:
        raise PermissionDenied("Only the requester can cancel.")
    if req.status != "pending":
        raise Conflict("الطلب ليس قيد الاعتماد.")
    with transaction.atomic():
        req.steps.filter(status__in=["active", "waiting"]).update(status="cancelled")
        req.status = "cancelled"
        req.decided_at = timezone.now()
        req.save(update_fields=["status", "decided_at"])
    log(actor=user, action="approval_cancelled", target_type="approval_request", target_id=req.id)
    return req


def complete_request(user, req) -> ApprovalRequest:
    if req.requested_by_id != user.id:
        raise PermissionDenied("Only the requester can complete.")
    if req.status != "approved":
        raise Conflict("لا يُكمل إلا طلب معتمد.")
    req.status = "completed"
    req.completed_at = timezone.now()
    req.save(update_fields=["status", "completed_at"])
    log(actor=user, action="approval_completed", target_type="approval_request", target_id=req.id)
    return req


# --- listings ------------------------------------------------------------------------------------

def pending_for(user) -> list[ApprovalRequest]:
    """Requests whose active step has a slot this user may fill now."""
    now = timezone.now()
    delegators = list(active_delegations(now).filter(delegate=user).values_list("delegator_id", flat=True))
    candidates = (
        ApprovalRequest.objects.filter(
            status="pending",
            steps__status="active",
            steps__approvers__user_id__in=[user.id, *delegators],
        )
        .select_related("correspondence", "requested_by")
        .distinct()
        .order_by("created_at")
    )
    return [r for r in candidates if can_read(user, r.correspondence) and available_slot(user, r)]
