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
    return _resolve_for_membership(selector, correspondence.sender_membership)


def _resolve_for_membership(selector: dict, membership) -> list[str]:
    """Approver ids for one selector, relative to the requester's unit.
    scope "central" = a centrally assigned role (the executive, the admin)."""
    if "user" in selector:
        return [str(selector["user"])]
    role = selector.get("role")
    scope = selector.get("scope")
    filters = {"role__code": role, "user__is_active": True}
    if scope == "central":
        filters.update(institute__isnull=True, branch__isnull=True, department__isnull=True)
    elif scope == "sender_institute":
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


def is_signed_request(req) -> bool:
    return bool(req.source_file_id and req.workflow_id and req.workflow.signable)


def decide(*, user, request_id, decision: str, password: str | None = None, page=None,
           position: tuple[float, float] | None = None) -> ApprovalDecision:
    req = get_viewable(user, request_id)
    if decision not in DECISIONS:
        raise ValidationError({"decision": "قرار غير معروف."})
    signing = decision == "approved" and is_signed_request(req)
    if signing:
        # Approving a signed request stamps the saved signature: confirm it is the approver.
        if not user.check_password(password or ""):
            raise ValidationError({"password": "كلمة المرور غير صحيحة."})
        if signature_png(user) is None:
            raise ValidationError({"signature": "احفظ توقيعك أولًا."})
        if page in (None, ""):
            raise ValidationError({"page": "اختر الصفحة التي توقّع عليها."})
    with transaction.atomic():
        req = ApprovalRequest.objects.select_for_update().get(pk=req.pk)
        if req.status != "pending":
            raise Conflict("الطلب ليس قيد الاعتماد.")
        step = current_step(req)
        slot = available_slot(user, req, step)
        if slot is None:
            raise PermissionDenied("You are not an approver of the current step (or already decided).")
        slot_user_id, delegation = slot
        code = None
        if signing:
            page = _checked_page(req, page)
            code = _new_verify_code()
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
                    verify_code=code,
                    signed_page=page if signing else None,
                )
        except IntegrityError:
            raise Conflict("سبق اتخاذ قرار في هذه الخانة.")
        if signing:
            _sign(req, user, delegation, page, code, position)
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
            "signed": signing,
        },
    )
    return row


# --- signed requests (user decision 2026-11-21) -----------------------------------------------

ROLE_PRIORITY = ["executive", "sys_admin", "regional_manager", "branch_manager"]


def _role_label(user) -> str:
    from apps.authorization.services import active_assignments

    roles = {a.role.code: a.role.name_ar for a in active_assignments(user)}
    for code in ROLE_PRIORITY:
        if code in roles:
            return roles[code]
    return next(iter(roles.values()), "")


def signature_png(user) -> bytes | None:
    from apps import vault

    from .models import UserSignature

    row = UserSignature.objects.filter(user=user).first()
    if row is None:
        return None
    try:
        return vault.open_(bytes(row.image_enc), purpose="signature", owner=user.id)
    except vault.VaultError:
        return None


def save_signature(user, data: bytes) -> None:
    from apps import vault

    from . import signing
    from .models import UserSignature

    png = signing.clean_signature(data)
    UserSignature.objects.update_or_create(
        user=user, defaults={"image_enc": vault.seal(png, purpose="signature", owner=user.id)}
    )
    log(actor=user, action="signature_saved", target_type="user", target_id=user.id)


def delete_signature(user) -> None:
    from .models import UserSignature

    if UserSignature.objects.filter(user=user).delete()[0]:
        log(actor=user, action="signature_deleted", target_type="user", target_id=user.id)


def ensure_page_count(req) -> int:
    """Pages of the request's document (counted once for older requests)."""
    if req.page_count == 0 and req.source_file_id:
        from apps.correspondence.services import read_blob

        from . import signing

        req.page_count = signing.page_count(read_blob(req.source_file))
        req.save(update_fields=["page_count"])
    return req.page_count


# Verification codes: no 0/O, 1/I/L — easy to read off paper and type.
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"


def _new_verify_code() -> str:
    import secrets

    while True:
        raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        code = f"{raw[:4]}-{raw[4:]}"
        if not ApprovalDecision.objects.filter(verify_code=code).exists():
            return code


def normalize_code(text: str) -> str:
    raw = "".join(ch for ch in (text or "").upper() if ch.isalnum())
    return f"{raw[:4]}-{raw[4:8]}" if len(raw) == 8 else ""


def verify_signature(user, code: str) -> dict:
    """What a printed code proves: who signed which request, when, on which
    page — never the content. Any signed-in employee may check."""
    code = normalize_code(code)
    d = (ApprovalDecision.objects.filter(verify_code=code).select_related(
        "approver", "slot_user", "request__correspondence", "request__workflow", "request__requested_by"
    ).first() if code else None)
    log(actor=user, action="signature_verified", target_type="approval_decision",
        target_id=d.id if d else None, metadata={"valid": d is not None})
    if d is None:
        return {"valid": False}
    r = d.request
    return {
        "valid": True,
        "code": code,
        "signer": d.approver.full_name or d.approver.username,
        "on_behalf_of": (d.slot_user.full_name or d.slot_user.username) if d.delegation_id else None,
        "signed_at": d.decided_at.isoformat(),
        "page": d.signed_page,
        "request_type": r.workflow.name if r.workflow_id else None,
        "reference_number": r.correspondence.reference_number,
        "requested_by": r.requested_by.full_name or r.requested_by.username,
        "request_status": r.status,
    }


def _checked_page(req, page) -> int:
    pages = ensure_page_count(req)
    try:
        page = int(page)
    except (TypeError, ValueError):
        raise ValidationError({"page": "اختر الصفحة التي توقّع عليها."})
    if not 1 <= page <= pages:
        raise ValidationError({"page": f"اختر صفحة من 1 إلى {pages}."})
    return page


def _taken_boxes(req, page: int, width: float, height: float, on_page: dict) -> list[dict]:
    """Boxes already on `page`: the recorded ones, plus those stamped before
    positions were recorded (they sit in the bottom slots, in order)."""
    from . import signing

    boxes = [b for b in (req.signature_boxes or []) if b.get("page") == page]
    legacy = max(0, on_page.get(str(page), 0) - len(boxes))
    for slot in range(legacy):
        col, row = slot % signing.PER_ROW, slot // signing.PER_ROW
        boxes.append({"page": page, "w": signing.BOX_W, "h": signing.BOX_H,
                      "x": width - signing.MARGIN - (col + 1) * signing.BOX_W - col * signing.GAP,
                      "y": height - signing.MARGIN - (row + 1) * signing.BOX_H - row * signing.GAP})
    return boxes


def _sign(req, user, delegation, page, code, position=None) -> None:
    """Stamp `user`'s signature on page `page` of the request's document
    (inside decide()), where they placed it or in the first free bottom slot."""
    from apps.correspondence.services import read_blob, store_blob

    from . import signing

    pages = ensure_page_count(req)
    on_page = dict(req.page_signatures or {})
    if not on_page and req.signature_count:
        on_page = {str(pages): req.signature_count}  # signed before page choice: all on the last page

    base_pdf = read_blob(req.signed_file or req.source_file)
    width, height = signing.page_size(base_pdf, page)
    at = signing.place(width, height, _taken_boxes(req, page, width, height, on_page), position)
    role = _role_label(user)
    if delegation is not None:
        role = f"بالتفويض عن {delegation.delegator.full_name}"
    when = timezone.localtime().strftime("%Y-%m-%d %H:%M")
    reference = req.correspondence.reference_number or ""
    pdf = signing.stamp(
        base_pdf, signature_png=signature_png(user), name=user.full_name or user.username,
        role=role, when=when, reference=reference, page=page, at=at, code=code,
    )
    stored = store_blob(user, pdf, name=f"{reference or 'طلب'} - موقّع.pdf", mime="application/pdf")
    on_page[str(page)] = on_page.get(str(page), 0) + 1
    req.signed_file = stored
    req.signature_count += 1
    req.page_signatures = on_page
    req.signature_boxes = [*(req.signature_boxes or []),
                           {"page": page, "x": round(at[0], 1), "y": round(at[1], 1), "w": signing.BOX_W, "h": signing.BOX_H}]
    req.save(update_fields=["signed_file", "signature_count", "page_signatures", "signature_boxes"])


MAX_REQUEST_FILE_BYTES = 15 * 1024 * 1024


def request_types(user) -> list[ApprovalWorkflow]:
    """Signed request types the user may file (global, or of their own unit)."""
    from apps.correspondence.services import resolve_sender_membership

    try:
        m = resolve_sender_membership(user, None)
    except Exception:
        return []
    return [
        w for w in ApprovalWorkflow.objects.filter(is_active=True, signable=True).prefetch_related("steps").order_by("name")
        if (w.institute_id in (None, m.institute_id)) and (w.branch_id in (None, m.branch_id))
        and (w.department_id in (None, m.department_id))
    ]


def file_request(*, requester, workflow_id, title: str, note: str, data: bytes, filename: str) -> ApprovalRequest:
    """«طلب جديد»: the document goes as a correspondence to every approver of
    the request type (so they can read it), then the approval runs on it."""
    import uuid as _uuid

    from apps.correspondence.models import Correspondence
    from apps.correspondence.services import create_correspondence, resolve_sender_membership, store_blob

    from . import signing

    workflow = next((w for w in request_types(requester) if str(w.id) == str(workflow_id)), None)
    if workflow is None:
        raise ValidationError({"workflow_id": "نوع طلب غير متاح لك."})
    title = " ".join((title or "").split())[:200]
    if not title:
        raise ValidationError({"title": "اكتب عنوان الطلب."})
    if not data or len(data) > MAX_REQUEST_FILE_BYTES:
        raise ValidationError({"file": "أرفق ملف الطلب (حتى 15 م.ب)."})
    membership = resolve_sender_membership(requester, None)
    approvers: list[str] = []
    for tpl in workflow.steps.order_by("step_order"):
        ids = [i for sel in tpl.approver_selectors for i in _resolve_for_membership(sel, membership)]
        if not ids:
            raise ValidationError({"workflow_id": f"لا يوجد معتمد للخطوة {tpl.step_order} لفرعك — راجع مدير النظام."})
        approvers.extend(i for i in ids if i not in approvers)
    if str(requester.id) in approvers:
        raise ValidationError({"workflow_id": "أنت من معتمدي هذا الطلب — لا يعتمد أحد طلبه بنفسه."})

    pdf = signing.to_pdf(data)
    base_name = (filename or "طلب").rsplit(".", 1)[0][:150]
    stored = store_blob(requester, pdf, name=f"{base_name}.pdf", mime="application/pdf")
    with transaction.atomic():
        result = create_correspondence(
            requester=requester, to_ids=approvers, cc_ids=[], bcc_ids=[], priority="normal",
            classification="normal", due_date=None, membership_id=membership.id, client_ref=_uuid.uuid4(),
            subject=f"{workflow.name}: {title}", body=note or "", attachment_ids=[str(stored.id)], send=True,
        )
        corr = Correspondence.objects.select_related("content_message", "sender_membership").get(pk=result.correspondence.pk)
        req = create_request(requester=requester, correspondence=corr, workflow_id=workflow.id)
        req.source_file = stored
        req.page_count = signing.page_count(pdf)
        req.save(update_fields=["source_file", "page_count"])
    return req


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

def remove_approver(user, req, approver_id) -> dict:
    """The requester takes an approver who has not decided off a pending
    request (user decision 2026-11-21). For a filed request (طلب صرف…) whose
    correspondence exists only for the approval, the person also loses the
    request entirely: it leaves their inbox, search and notifications. On an
    ordinary correspondence they only stop being an approver — the mail the
    sender chose to send them stays."""
    from apps.messaging.models import ConversationMember
    from apps.notifications.models import Notification

    if req.requested_by_id != user.id:
        raise PermissionDenied("Only the requester can change the approvers.")
    approver_id = str(approver_id)
    with transaction.atomic():
        req = ApprovalRequest.objects.select_for_update().get(pk=req.pk)
        if req.status != "pending":
            raise Conflict("الطلب ليس قيد الاعتماد.")
        decided = {str(d.step_id) for d in req.decisions.filter(slot_user_id=approver_id)}
        slots = [s for s in ApprovalStepApprover.objects.filter(step__request=req, user_id=approver_id).select_related("step")
                 if str(s.step_id) not in decided and s.step.status in ("active", "waiting")]
        if not slots:
            raise ValidationError({"approver_id": "ليس معتمدًا لم يقرر بعد في هذا الطلب."})
        for slot in slots:
            if slot.step.approvers.count() <= 1:
                raise ValidationError({"approver_id": f"آخر معتمد في الخطوة {slot.step.step_order} — ألغِ الطلب بدلًا من ذلك."})
        for slot in slots:
            slot.delete()
        step = current_step(req)
        if (step is not None and step.status == "active" and step.step_type == "all"
                and step.decisions.filter(decision="approved").count() >= step.approvers.count()):
            last = step.decisions.filter(decision="approved").order_by("-decided_at").first()
            _advance(req, step, last)  # the others had already approved

        hidden = False
        if req.source_file_id and not decided:
            c = req.correspondence
            now = timezone.now()
            hidden = bool(CorrespondenceParticipant.objects.filter(
                correspondence=c, user_id=approver_id, kind__in=("to", "cc"), removed_at__isnull=True
            ).update(removed_at=now))
            ConversationMember.objects.filter(conversation_id=c.thread_id, user_id=approver_id,
                                              removed_at__isnull=True).update(removed_at=now)
            Notification.objects.filter(user_id=approver_id, ref_id__in=[req.id, c.id]).delete()
        else:
            Notification.objects.filter(user_id=approver_id, ref_id=req.id).delete()
    log(actor=user, action="approval_approver_removed", target_type="approval_request", target_id=req.id,
        metadata={"approver_id": approver_id, "slots": len(slots), "hidden": hidden})
    return {"removed": len(slots), "hidden": hidden}


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
