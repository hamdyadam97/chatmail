"""/api/v1/approvals/ — approval requests, signed decisions, delegations, templates.

Every request object goes through services.get_viewable (participants of the
correspondence only). There is no role that sees approval requests outside
that rule.
"""
import base64
import binascii

from django.db import transaction
from rest_framework import serializers, status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from apps.authorization.services import has_permission
from apps.correspondence.models import Correspondence
from apps.correspondence.services import get_readable
from apps.org.models import Branch, Department, Institute

from .. import services
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
        "device_id": str(d.approver_device_id),
        "decided_at": d.decided_at.isoformat(),
        # Verifiable by any participant against the directory's device key.
        "payload": base64.b64encode(bytes(d.decision_payload)).decode(),
        "signature": base64.b64encode(bytes(d.signature)).decode(),
    }


def request_dict(req: ApprovalRequest, viewer) -> dict:
    steps = []
    for step in req.steps.prefetch_related("approvers__user", "decisions__approver").order_by("step_order"):
        by_slot = {str(d.slot_user_id): d for d in step.decisions.all()}
        steps.append(
            {
                "step_order": step.step_order,
                "step_type": step.step_type,
                "status": step.status,
                "approvers": [
                    {
                        "user": _user_ref(a.user),
                        "decision": _decision_dict(by_slot[str(a.user_id)]) if str(a.user_id) in by_slot else None,
                    }
                    for a in step.approvers.all()
                ],
            }
        )
    slot = services.available_slot(viewer, req)
    c = req.correspondence
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
        "signing_context": services.SIGNING_CONTEXT.decode(),
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
        elif box == "correspondence":
            correspondence = get_readable(request.user, request.query_params.get("correspondence_id"))
            items = list(
                correspondence.approval_requests.select_related("correspondence", "requested_by").order_by("-created_at")
            )
        else:
            raise ValidationError({"box": "pending_mine | requested_by_me | correspondence"})
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
    payload = serializers.CharField(max_length=4096)
    signature = serializers.CharField(max_length=200)
    device_id = serializers.UUIDField()

    def validate(self, attrs):
        try:
            attrs["payload_raw"] = base64.b64decode(attrs["payload"], validate=True)
            attrs["signature_raw"] = base64.b64decode(attrs["signature"], validate=True)
        except (binascii.Error, ValueError):
            raise serializers.ValidationError("base64 غير صالح.")
        return attrs


class DecideView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [DecisionThrottle]

    def post(self, request, request_id):
        serializer = DecideSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        decision = services.decide(
            user=request.user,
            request_id=request_id,
            payload=data["payload_raw"],
            signature=data["signature_raw"],
            device_id=data["device_id"],
        )
        return Response(request_dict(decision.request, request.user), status=status.HTTP_201_CREATED)


class CancelView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, request_id):
        req = services.cancel_request(request.user, services.get_viewable(request.user, request_id))
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
        for sel in value:
            if "user" in sel:
                continue
            if sel.get("scope") not in ("sender_institute", "sender_branch", "sender_department") or not sel.get("role"):
                raise serializers.ValidationError("selector: {user} أو {role, scope}.")
        return value


class WorkflowSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200)
    institute_id = serializers.UUIDField(required=False, allow_null=True)
    branch_id = serializers.UUIDField(required=False, allow_null=True)
    department_id = serializers.UUIDField(required=False, allow_null=True)
    steps = _TemplateStep(many=True, allow_empty=False, max_length=services.MAX_STEPS)


def _workflow_dict(w) -> dict:
    return {
        "id": str(w.id),
        "name": w.name,
        "version": w.version,
        "institute_id": str(w.institute_id) if w.institute_id else None,
        "branch_id": str(w.branch_id) if w.branch_id else None,
        "department_id": str(w.department_id) if w.department_id else None,
        "steps": [
            {"step_order": s.step_order, "type": s.step_type, "approver_selectors": s.approver_selectors}
            for s in w.steps.order_by("step_order")
        ],
    }


class WorkflowListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs = ApprovalWorkflow.objects.filter(is_active=True).prefetch_related("steps").order_by("name")
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
                created_by=request.user,
            )
            for i, step in enumerate(data["steps"], start=1):
                ApprovalStep.objects.create(
                    workflow=w, step_order=i, step_type=step["type"], approver_selectors=step["approver_selectors"]
                )
        return Response(_workflow_dict(w), status=status.HTTP_201_CREATED)
