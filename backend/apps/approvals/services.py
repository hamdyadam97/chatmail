"""Approval workflow engine (prompt §11; docs/phase1/04-erd.md §4.2 ح).

Rules enforced here:
  * Only the sender of a SENT correspondence opens a request on it; at most
    one pending request per correspondence.
  * Every approver must be a live to/cc participant (they decrypt through the
    thread's MLS group) and cannot be the requester. The engine never widens
    who can read anything.
  * Steps run in order; a step of type ``all`` needs every slot approved, an
    ``any`` step needs one. Reject/return ends the request.
  * A decision is accepted only with a valid Ed25519 signature by one of the
    approver's own active devices over SIGNING_CONTEXT ‖ canonical payload,
    where the payload binds request, step, correspondence, the SHA-256 of the
    ciphertext reviewed, the decision, the acting user, the slot and the
    device. Duplicate decisions are impossible (UNIQUE(step, slot_user)).
  * Delegation is temporary and transfers decision authority only — the
    delegate must be a participant in their own right.
"""
import base64
import hashlib
import json
from datetime import datetime, timedelta

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError
from rest_framework.status import HTTP_409_CONFLICT

from apps.accounts.models import TrustedDevice, User
from apps.audit.services import log
from apps.authorization.models import UserRoleAssignment
from apps.correspondence.models import CorrespondenceParticipant
from apps.correspondence.services import can_read
from apps.notifications.services import notify

from .models import (
    ApprovalDecision,
    ApprovalDelegation,
    ApprovalRequest,
    ApprovalRequestStep,
    ApprovalStepApprover,
    ApprovalWorkflow,
)

SIGNING_CONTEXT = b"corr-approval-decision-v1\n"
MAX_CLOCK_SKEW = timedelta(minutes=10)
MAX_STEPS = 10
MAX_APPROVERS_PER_STEP = 20
MAX_DELEGATION = timedelta(days=90)
PAYLOAD_FIELDS = (
    "approver_id",
    "content_hash",
    "correspondence_id",
    "decided_at",
    "decision",
    "device_id",
    "on_behalf_of",
    "request_id",
    "step_order",
)


class Conflict(APIException):
    status_code = HTTP_409_CONFLICT
    default_detail = "conflict"
    default_code = "conflict"


def b64(raw: bytes) -> str:
    return base64.b64encode(bytes(raw)).decode("ascii")


def canonical_bytes(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def content_hash_of(correspondence) -> bytes:
    return hashlib.sha256(bytes(correspondence.content_message.mls_payload)).digest()


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


def expected_payload(*, req, step, user, slot_user_id, delegation, device_id, decision, decided_at) -> dict:
    return {
        "approver_id": str(user.id),
        "content_hash": b64(req.content_hash),
        "correspondence_id": str(req.correspondence_id),
        "decided_at": decided_at,
        "decision": decision,
        "device_id": str(device_id),
        "on_behalf_of": slot_user_id if delegation else None,
        "request_id": str(req.id),
        "step_order": step.step_order,
    }


def _parse_payload(raw: bytes) -> dict:
    try:
        parsed = json.loads(raw.decode("ascii"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValidationError({"payload": "حمولة القرار ليست JSON ASCII صالحًا."})
    if not isinstance(parsed, dict) or tuple(sorted(parsed)) != PAYLOAD_FIELDS:
        raise ValidationError({"payload": "حقول حمولة القرار غير مطابقة."})
    if canonical_bytes(parsed) != raw:
        raise ValidationError({"payload": "الحمولة ليست بالصيغة القانونية (canonical JSON)."})
    return parsed


def _parse_time(value) -> datetime:
    try:
        when = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise ValidationError({"payload": "decided_at غير صالح."})
    if when.tzinfo is None:
        raise ValidationError({"payload": "decided_at بلا منطقة زمنية."})
    return when


def decide(*, user, request_id, payload: bytes, signature: bytes, device_id) -> ApprovalDecision:
    req = get_viewable(user, request_id)
    parsed = _parse_payload(payload)
    device = TrustedDevice.objects.filter(id=device_id, user=user, status="active").first()
    if device is None or not device.identity_sign_pub:
        raise PermissionDenied("Decisions must be signed by one of your active devices.")
    try:
        Ed25519PublicKey.from_public_bytes(bytes(device.identity_sign_pub)).verify(
            signature, SIGNING_CONTEXT + payload
        )
    except (InvalidSignature, ValueError):
        raise ValidationError({"signature": "توقيع القرار غير صالح."})
    if abs(timezone.now() - _parse_time(parsed["decided_at"])) > MAX_CLOCK_SKEW:
        raise ValidationError({"payload": "وقت القرار بعيد عن وقت الخادم."})
    if parsed["decision"] not in ("approved", "rejected", "returned"):
        raise ValidationError({"payload": "قرار غير معروف."})

    with transaction.atomic():
        req = ApprovalRequest.objects.select_for_update().get(pk=req.pk)
        if req.status != "pending":
            raise Conflict("الطلب ليس قيد الاعتماد.")
        step = current_step(req)
        slot = available_slot(user, req, step)
        if slot is None:
            raise PermissionDenied("You are not an approver of the current step (or already decided).")
        slot_user_id, delegation = slot
        expected = expected_payload(
            req=req, step=step, user=user, slot_user_id=slot_user_id, delegation=delegation,
            device_id=device.id, decision=parsed["decision"], decided_at=parsed["decided_at"],
        )
        if parsed != expected:
            mismatched = sorted(k for k in PAYLOAD_FIELDS if parsed.get(k) != expected.get(k))
            raise ValidationError({"payload": f"الحمولة لا تطابق الطلب: {', '.join(mismatched)}"})
        try:
            with transaction.atomic():
                decision = ApprovalDecision.objects.create(
                    request=req,
                    step=step,
                    slot_user_id=slot_user_id,
                    approver=user,
                    delegation=delegation,
                    approver_device=device,
                    decision=parsed["decision"],
                    content_hash=req.content_hash,
                    decision_payload=payload,
                    signature=signature,
                )
        except IntegrityError:
            raise Conflict("سبق اتخاذ قرار في هذه الخانة.")
        _advance(req, step, decision)

    log(
        actor=user,
        actor_device=device,
        action="approval_decided",
        target_type="approval_request",
        target_id=req.id,
        metadata={
            "decision": decision.decision,
            "step_order": step.step_order,
            "delegated": delegation is not None,
        },
    )
    return decision


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
