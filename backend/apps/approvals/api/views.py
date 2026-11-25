"""/api/v1/approvals/ — approval requests, signed decisions, delegations, templates.

Every request object goes through services.get_viewable (participants of the
correspondence only). There is no role that sees approval requests outside
that rule.
"""

import base64
import binascii
import uuid

from django.db import transaction
from rest_framework import serializers, status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from apps.audit.services import log
from apps.authorization.services import has_permission
from apps.correspondence.models import Correspondence
from apps.correspondence.services import correspondence_content, file_meta, get_readable
from apps.org.models import Branch, Department, Institute

from .. import services, signing
from ..models import ApprovalDelegation, ApprovalRequest, ApprovalStep, ApprovalWorkflow


class DecisionThrottle(SimpleRateThrottle):
    scope = "approval_decision"
    rate = "30/min"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": str(request.user.pk)}


def _user_ref(user) -> dict:
    return {"id": str(user.id), "full_name": user.full_name, "username": user.username}


def _decision_dict(d) -> dict:
    return {
        "decision": d.decision,
        "slot_user_id": str(d.slot_user_id),
        "approver": _user_ref(d.approver),
        "delegated": d.delegation_id is not None,
        "decided_at": d.decided_at.isoformat(),
        "verify_code": d.verify_code,
        "signed_page": d.signed_page,
    }


def _event_dict(e) -> dict:
    return {
        "kind": e.kind,
        "actor": _user_ref(e.actor),
        "on_behalf_of": _user_ref(e.on_behalf_of) if e.on_behalf_of_id else None,
        "step_order": e.step_order,
        "round": e.round,
        "note": services.event_note(e),
        "created_at": e.created_at.isoformat(),
    }


def request_dict(req: ApprovalRequest, viewer) -> dict:
    steps = []
    for step in req.steps.prefetch_related("approvers__user", "decisions__approver").order_by("step_order"):
        by_slot = {str(d.slot_user_id): d for d in step.decisions.all() if d.round == req.round}
        steps.append(
            {
                "step_order": step.step_order,
                "step_type": step.step_type,
                "status": step.status,
                "approvers": [
                    {
                        "user": _user_ref(a.user),
                        "decision": _decision_dict(by_slot[str(a.user_id)]) if str(a.user_id) in by_slot else None,
                        "deferred_at": a.deferred_at.isoformat() if a.deferred_at else None,
                    }
                    for a in step.approvers.all()
                ],
            }
        )
    slot = services.available_slot(viewer, req)
    # The executive, before their turn: may approve or reject directly (earlier steps get skipped).
    early = services.early_step(viewer, req) if slot is None else None
    c = req.correspondence
    signed_request = services.is_signed_request(req)
    content = (correspondence_content(c) or {}) if signed_request else {}
    return {
        "id": str(req.id),
        "correspondence": {"id": str(c.id), "reference_number": c.reference_number},
        "status": req.status,
        "current_step_order": req.current_step_order,
        "requested_by": _user_ref(req.requested_by),
        "content_hash": services.b64(req.content_hash),
        "workflow_id": str(req.workflow_id) if req.workflow_id else None,
        "created_at": req.created_at.isoformat(),
        "decided_at": req.decided_at.isoformat() if req.decided_at else None,
        "completed_at": req.completed_at.isoformat() if req.completed_at else None,
        "steps": steps,
        "my_slot": {"slot_user_id": slot[0], "delegated": slot[1] is not None} if slot else None,
        "my_early_step": early.step_order if early is not None else None,
        # «تذكير بالتوقيع» (the executive, before their turn): when last sent.
        "reminded_at": (lambda t: t.isoformat() if t else None)(services.last_reminder(req)) if early is not None else None,
        # Signed requests (طلب صرف، إجازة…): the type, the title and the document.
        "signable": signed_request,
        "workflow_name": req.workflow.name if req.workflow_id else None,
        "title": content.get("subject") if signed_request else None,
        "source_file": file_meta(req.source_file) if req.source_file_id else None,
        "signed_file": file_meta(req.signed_file) if req.signed_file_id else None,
        "signature_count": req.signature_count,
        # Every approver chooses the page they sign.
        "page_count": services.ensure_page_count(req) if signed_request else None,
        "page_signatures": req.page_signatures or {},
        "signature_boxes": req.signature_boxes or [],
        "signature_box": {"w": signing.BOX_W, "h": signing.BOX_H} if signed_request else None,
        # Timeline (decisions, deferrals, resubmissions) with their notes, oldest first.
        "round": req.round,
        "events": [_event_dict(e) for e in req.events.select_related("actor", "on_behalf_of").order_by("created_at")],
        "can_resubmit": req.status == "returned" and req.requested_by_id == viewer.id,
    }


class _StepSpec(serializers.Serializer):
    type = serializers.ChoiceField(choices=["all", "any"], default="all")
    approver_ids = serializers.ListField(child=serializers.UUIDField(), allow_empty=False)


class CreateRequestSerializer(serializers.Serializer):
    correspondence_id = serializers.UUIDField()
    steps = _StepSpec(many=True, required=False)
    workflow_id = serializers.UUIDField(required=False)

    def validate(self, attrs):
        if bool(attrs.get("steps")) == bool(attrs.get("workflow_id")):
            raise serializers.ValidationError("حدد الخطوات أو مسارًا معرّفًا (أحدهما فقط).")
        return attrs


class ApprovalListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        box = request.query_params.get("box", "pending_mine")
        if box == "pending_mine":
            items = services.pending_for(request.user)
        elif box == "requested_by_me":
            items = list(
                ApprovalRequest.objects.filter(requested_by=request.user)
                .select_related("correspondence", "requested_by")
                .order_by("-created_at")[:200]
            )
        elif box == "received":
            # Every request I am (or was) an approver of — to find it again after signing.
            from apps.correspondence.services import can_read

            items = [
                r for r in ApprovalRequest.objects.filter(steps__approvers__user=request.user)
                .select_related("correspondence", "requested_by", "workflow").distinct().order_by("-created_at")[:200]
                if can_read(request.user, r.correspondence)
            ]
        elif box == "cancelled_mine":
            # Requests that waited for me and were cancelled (last 30 days): shown, not actionable.
            from datetime import timedelta

            from django.utils import timezone

            from apps.correspondence.services import can_read

            since = timezone.now() - timedelta(days=30)
            items = [
                r for r in ApprovalRequest.objects.filter(
                    status="cancelled", decided_at__gte=since, steps__approvers__user=request.user
                ).select_related("correspondence", "requested_by", "workflow").distinct().order_by("-decided_at")[:50]
                if can_read(request.user, r.correspondence)
            ]
        elif box == "correspondence":
            correspondence = get_readable(request.user, request.query_params.get("correspondence_id"))
            items = list(
                correspondence.approval_requests.select_related("correspondence", "requested_by").order_by("-created_at")
            )
        else:
            raise ValidationError({"box": "pending_mine | received | cancelled_mine | requested_by_me | correspondence"})
        return Response([request_dict(r, request.user) for r in items])

    def post(self, request):
        serializer = CreateRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        correspondence = get_readable(request.user, data["correspondence_id"])
        req = services.create_request(
            requester=request.user,
            correspondence=Correspondence.objects.select_related("content_message", "sender_membership").get(
                pk=correspondence.pk
            ),
            steps=[{"type": s["type"], "approver_ids": s["approver_ids"]} for s in data.get("steps") or []] or None,
            workflow_id=data.get("workflow_id"),
        )
        return Response(request_dict(req, request.user), status=status.HTTP_201_CREATED)


class ApprovalDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, request_id):
        return Response(request_dict(services.get_viewable(request.user, request_id), request.user))


class DecideSerializer(serializers.Serializer):
    decision = serializers.ChoiceField(choices=list(services.DECISIONS))
    # Approving a signed request stamps the saved signature: current password required.
    password = serializers.CharField(required=False, allow_blank=True, write_only=True, trim_whitespace=False)
    page = serializers.IntegerField(required=False, min_value=1)
    # Where the approver placed the box: top-left in PDF points (optional; default bottom of the page).
    x = serializers.FloatField(required=False)
    y = serializers.FloatField(required=False)
    # Optional note to the requester (reason for return/rejection…), sealed.
    note = serializers.CharField(required=False, allow_blank=True, max_length=services.MAX_NOTE)

    def validate(self, attrs):
        if ("x" in attrs) != ("y" in attrs):
            raise serializers.ValidationError({"position": "حدد مكان التوقيع كاملًا (x و y)."})
        return attrs


class DecideView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [DecisionThrottle]

    def post(self, request, request_id):
        serializer = DecideSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        decision = services.decide(
            user=request.user, request_id=request_id, decision=serializer.validated_data["decision"],
            password=serializer.validated_data.get("password"),
            page=serializer.validated_data.get("page"),
            position=(serializer.validated_data["x"], serializer.validated_data["y"])
            if "x" in serializer.validated_data else None,
            note=serializer.validated_data.get("note", ""),
        )
        return Response(request_dict(decision.request, request.user), status=status.HTTP_201_CREATED)


class DeferView(APIView):
    """POST {note?}: «تأجيل» — the approver keeps the request and decides later."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [DecisionThrottle]

    def post(self, request, request_id):
        note = request.data.get("note") or ""
        if len(str(note)) > services.MAX_NOTE:
            raise ValidationError({"note": f"الملاحظة حتى {services.MAX_NOTE} حرف."})
        req = services.defer(user=request.user, request_id=request_id, note=note)
        return Response(request_dict(req, request.user))


class ResubmitView(APIView):
    """POST multipart|json {note?, file?}: the requester sends a returned request back."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [DecisionThrottle]

    def post(self, request, request_id):
        req = services.get_viewable(request.user, request_id)
        note = request.data.get("note") or ""
        if len(str(note)) > services.MAX_NOTE:
            raise ValidationError({"note": f"الملاحظة حتى {services.MAX_NOTE} حرف."})
        upload = request.FILES.get("file")
        if upload is not None and upload.size > services.MAX_REQUEST_FILE_BYTES:
            raise ValidationError({"file": "الملف أكبر من 15 م.ب."})
        req = services.resubmit(
            request.user, req, note=note,
            data=upload.read() if upload is not None else None, filename=upload.name if upload is not None else "",
        )
        return Response(request_dict(req, request.user))


class RemindView(APIView):
    """POST: the executive reminds the current step's approvers to sign (once an hour)."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [DecisionThrottle]

    def post(self, request, request_id):
        req = services.get_viewable(request.user, request_id)
        sent = services.remind(request.user, req)
        req.refresh_from_db()
        return Response({**request_dict(req, request.user), "reminded": len(sent)})


class CancelView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, request_id):
        req = services.cancel_request(request.user, services.get_viewable(request.user, request_id))
        return Response(request_dict(req, request.user))


class RemoveApproverView(APIView):
    """POST {approver_id}: the requester takes an undecided approver off a pending request."""

    permission_classes = [IsAuthenticated]

    def post(self, request, request_id):
        req = services.get_viewable(request.user, request_id)
        approver_id = request.data.get("approver_id")
        try:
            uuid.UUID(str(approver_id))
        except ValueError:
            raise ValidationError({"approver_id": "معتمد غير صالح."})
        services.remove_approver(request.user, req, approver_id)
        req.refresh_from_db()
        return Response(request_dict(req, request.user))


class CompleteView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, request_id):
        req = services.complete_request(request.user, services.get_viewable(request.user, request_id))
        return Response(request_dict(req, request.user))


# --- delegations ---------------------------------------------------------------------------

def _delegation_dict(d) -> dict:
    return {
        "id": str(d.id),
        "delegator": _user_ref(d.delegator),
        "delegate": _user_ref(d.delegate),
        "starts_at": d.starts_at.isoformat(),
        "ends_at": d.ends_at.isoformat(),
        "revoked_at": d.revoked_at.isoformat() if d.revoked_at else None,
    }


class DelegationSerializer(serializers.Serializer):
    delegate_id = serializers.UUIDField()
    starts_at = serializers.DateTimeField()
    ends_at = serializers.DateTimeField()


class DelegationListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs = ApprovalDelegation.objects.select_related("delegator", "delegate").order_by("-created_at")
        return Response(
            {
                "given": [_delegation_dict(d) for d in qs.filter(delegator=request.user)[:100]],
                "received": [_delegation_dict(d) for d in qs.filter(delegate=request.user)[:100]],
            }
        )

    def post(self, request):
        serializer = DelegationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        d = services.create_delegation(delegator=request.user, **serializer.validated_data)
        return Response(_delegation_dict(d), status=status.HTTP_201_CREATED)


class DelegationRevokeView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, delegation_id):
        return Response(_delegation_dict(services.revoke_delegation(request.user, delegation_id)))


# --- workflow templates ---------------------------------------------------------------------

class _TemplateStep(serializers.Serializer):
    type = serializers.ChoiceField(choices=["all", "any"], default="all")
    approver_selectors = serializers.ListField(child=serializers.DictField(), allow_empty=False, max_length=20)

    def validate_approver_selectors(self, value):
        from apps.accounts.models import User

        out = []
        for sel in value:
            if "user" in sel:
                try:
                    uuid.UUID(str(sel["user"]))
                except ValueError:
                    raise serializers.ValidationError("موظف غير صالح.")
                if not User.objects.filter(id=str(sel["user"]), is_active=True).exists():
                    raise serializers.ValidationError("الموظف المحدد غير موجود أو مؤرشف.")
                out.append({"user": str(sel["user"])})
                continue
            if sel.get("scope") not in ("central", "sender_institute", "sender_branch", "sender_department") or not sel.get("role"):
                raise serializers.ValidationError("selector: {user} أو {role, scope}.")
            allowed = ROLE_SCOPES.get(sel["role"])
            if allowed and sel["scope"] not in allowed:
                # e.g. «مدير الفرع — مركزي» never finds anyone: refuse it.
                raise serializers.ValidationError(ROLE_SCOPE_HINTS[sel["role"]])
            out.append({"role": sel["role"], "scope": sel["scope"]})
        return out


# Where each of the five roles is assigned, so which scope can ever resolve.
ROLE_SCOPES = {
    "branch_manager": {"sender_branch"},
    "regional_manager": {"sender_branch"},
    "executive": {"central"},
    "sys_admin": {"central"},
}
ROLE_SCOPE_HINTS = {
    "branch_manager": "«مدير الفرع» يُختار «في فرع مقدّم الطلب».",
    "regional_manager": "«المدير الإقليمي» يُختار «في فرع مقدّم الطلب».",
    "executive": "«المدير التنفيذي» على مستوى النظام كله.",
    "sys_admin": "«مدير النظام» على مستوى النظام كله.",
}


class WorkflowSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200)
    institute_id = serializers.UUIDField(required=False, allow_null=True)
    branch_id = serializers.UUIDField(required=False, allow_null=True)
    department_id = serializers.UUIDField(required=False, allow_null=True)
    signable = serializers.BooleanField(default=False)
    steps = _TemplateStep(many=True, allow_empty=False, max_length=services.MAX_STEPS)


def _named(selector: dict) -> dict:
    """A {user} selector with that employee's name, for display."""
    if "user" not in selector:
        return selector
    from apps.accounts.models import User

    u = User.objects.filter(id=selector["user"]).only("full_name", "username").first()
    return {**selector, "name": (u.full_name or u.username) if u else "موظف غير موجود"}


def _workflow_dict(w) -> dict:
    return {
        "id": str(w.id),
        "name": w.name,
        "version": w.version,
        "institute_id": str(w.institute_id) if w.institute_id else None,
        "branch_id": str(w.branch_id) if w.branch_id else None,
        "department_id": str(w.department_id) if w.department_id else None,
        "signable": w.signable,
        "steps": [
            {"step_order": s.step_order, "type": s.step_type, "approver_selectors": [_named(sel) for sel in s.approver_selectors]}
            for s in w.steps.order_by("step_order")
        ],
    }


class WorkflowListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs = ApprovalWorkflow.objects.filter(is_active=True).prefetch_related("steps").order_by("name")
        if request.query_params.get("signable") in ("0", "1"):
            qs = qs.filter(signable=request.query_params["signable"] == "1")
        return Response([_workflow_dict(w) for w in qs])

    def post(self, request):
        serializer = WorkflowSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        unit = None
        if data.get("department_id"):
            unit = Department.objects.filter(id=data["department_id"]).first()
        elif data.get("branch_id"):
            unit = Branch.objects.filter(id=data["branch_id"]).first()
        elif data.get("institute_id"):
            unit = Institute.objects.filter(id=data["institute_id"]).first()
        if any(data.get(k) for k in ("department_id", "branch_id", "institute_id")) and unit is None:
            raise ValidationError({"scope": "وحدة غير معروفة."})
        if not has_permission(request.user, "approvals.define", unit=unit):
            raise PermissionDenied("approvals.define is not granted in this unit.")
        with transaction.atomic():
            w = ApprovalWorkflow.objects.create(
                name=data["name"],
                institute=unit if isinstance(unit, Institute) else getattr(unit, "institute", None),
                branch=unit if isinstance(unit, Branch) else getattr(unit, "branch", None),
                department=unit if isinstance(unit, Department) else None,
                signable=data["signable"],
                created_by=request.user,
            )
            for i, step in enumerate(data["steps"], start=1):
                ApprovalStep.objects.create(
                    workflow=w, step_order=i, step_type=step["type"], approver_selectors=step["approver_selectors"]
                )
        return Response(_workflow_dict(w), status=status.HTTP_201_CREATED)


def _workflow_unit(w):
    return w.department or w.branch or w.institute


class WorkflowEditSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200, required=False)
    steps = _TemplateStep(many=True, allow_empty=False, max_length=services.MAX_STEPS, required=False)


class WorkflowDetailView(APIView):
    """PATCH (approvals.define in its unit):
      {is_active: false} — retire a workflow / request type;
      {name?, steps?}   — edit it. Requests already filed keep the steps they
                          were filed with (each request snapshots its steps);
                          new requests use the edited ones."""

    permission_classes = [IsAuthenticated]

    def patch(self, request, workflow_id):
        w = ApprovalWorkflow.objects.filter(id=workflow_id).first()
        if w is None or not has_permission(request.user, "approvals.define", unit=_workflow_unit(w)):
            raise PermissionDenied("approvals.define is not granted in this unit.")
        if "name" in request.data or "steps" in request.data:
            if not w.is_active:
                raise ValidationError({"detail": "النوع موقوف."})
            edit = WorkflowEditSerializer(data=request.data)
            edit.is_valid(raise_exception=True)
            data = edit.validated_data
            with transaction.atomic():
                if "name" in data:
                    w.name = data["name"].strip() or w.name
                if "steps" in data:
                    w.steps.all().delete()
                    for i, step in enumerate(data["steps"], start=1):
                        ApprovalStep.objects.create(
                            workflow=w, step_order=i, step_type=step["type"], approver_selectors=step["approver_selectors"]
                        )
                w.version += 1
                w.save(update_fields=["name", "version"])
            log(actor=request.user, action="approval_workflow_updated", target_type="approval_workflow", target_id=w.id,
                metadata={"version": w.version, "steps": w.steps.count()})
        if request.data.get("is_active") is False and w.is_active:
            w.is_active = False
            w.save(update_fields=["is_active"])
            log(actor=request.user, action="approval_workflow_retired", target_type="approval_workflow", target_id=w.id)
        return Response(_workflow_dict(w))


# --- signed requests (طلب صرف، إجازة…) ------------------------------------------------------------

class RequestTypesView(APIView):
    """GET: the signed request types the caller may file."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response([_workflow_dict(w) for w in services.request_types(request.user)])


class FileRequestThrottle(SimpleRateThrottle):
    scope = "approval_file_request"
    rate = "20/hour"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": str(request.user.pk)}


class FileRequestView(APIView):
    """POST multipart {workflow_id, title, note, file}: «طلب جديد»."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [FileRequestThrottle]

    def post(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationError({"file": "أرفق ملف الطلب."})
        if upload.size > services.MAX_REQUEST_FILE_BYTES:
            raise ValidationError({"file": "الملف أكبر من 15 م.ب."})
        req = services.file_request(
            requester=request.user,
            workflow_id=request.data.get("workflow_id"),
            title=request.data.get("title") or "",
            note=request.data.get("note") or "",
            data=upload.read(),
            filename=upload.name or "",
        )
        return Response(request_dict(req, request.user), status=status.HTTP_201_CREATED)


class SignatureView(APIView):
    """The caller's own saved signature: GET (PNG as base64), PUT {image}, DELETE."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        png = services.signature_png(request.user)
        return Response({"has_signature": png is not None, "image": base64.b64encode(png).decode() if png else None})

    def put(self, request):
        if "strokes" in request.data:
            # The mobile app: pen strokes drawn on the phone, rendered here.
            png = signing.render_strokes(request.data.get("strokes"), request.data.get("width"), request.data.get("height"))
            services.save_signature(request.user, png)
            return self.get(request)
        raw = str(request.data.get("image") or "")
        if raw.startswith("data:"):
            raw = raw.split(",", 1)[-1]
        try:
            data = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            raise ValidationError({"image": "صورة غير صالحة."})
        services.save_signature(request.user, data)
        return self.get(request)

    def delete(self, request):
        services.delete_signature(request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class VerifyThrottle(SimpleRateThrottle):
    scope = "signature_verify"
    rate = "30/min"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": str(request.user.pk)}


class VerifySignatureView(APIView):
    """GET ?code=XXXX-XXXX: is this printed signature real? Who, when, which
    request — never its content. Any signed-in employee."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [VerifyThrottle]

    def get(self, request):
        return Response(services.verify_signature(request.user, request.query_params.get("code") or ""))
