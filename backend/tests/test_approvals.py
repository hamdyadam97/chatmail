"""Approval workflow engine: sequential steps, all/any, server-recorded
decisions bound to the content version, duplicate prevention, delegation, and
privacy gates (SEC-01/02 style).
"""
from datetime import timedelta

import pytest
from django.db import IntegrityError
from django.utils import timezone

from apps.approvals.models import ApprovalDecision, ApprovalDelegation, ApprovalRequest
from apps.audit.models import AuditLog
from apps.notifications.models import Notification

from .approvals_utils import APPROVALS_URL, decide, request_approval
from .conftest import assign_role
from .correspondence_utils import (  # noqa: F401  (fixtures)
    _blob_root,
    make_employee,
    office,
    prepare_and_send,
)
from .messaging_utils import auth

pytestmark = pytest.mark.django_db


@pytest.fixture
def board(api_client, user_factory, branch_a, office):
    """Sent correspondence s → to r1, cc r2 + r3 (r3 an extra employee)."""
    r3 = make_employee(user_factory, "c_rcpt3", branch_a)
    office["r3"] = r3
    office["h_r3"] = auth(api_client, "c_rcpt3")
    sent = prepare_and_send(api_client, office["h_s"], [office["r1"]], [office["r2"], r3])
    office["corr"] = sent
    return office


def _ok(resp, code=201):
    assert resp.status_code == code, resp.content
    return resp.json()


def test_full_two_step_flow(api_client, board):
    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"],
                               [("all", [b["r1"], b["r2"]]), ("any", [b["r3"]])]))
    assert req["status"] == "pending" and req["current_step_order"] == 1
    assert Notification.objects.filter(kind="approval_requested", user__in=[b["r1"], b["r2"]]).count() == 2
    assert not Notification.objects.filter(kind="approval_requested", user=b["r3"]).exists()

    mine = api_client.get(f"{APPROVALS_URL}?box=pending_mine", **b["h_r1"]).json()
    assert [r["id"] for r in mine] == [req["id"]]
    assert mine[0]["my_slot"] == {"slot_user_id": str(b["r1"].id), "delegated": False}
    # r3 is not on step 1 yet
    assert api_client.get(f"{APPROVALS_URL}?box=pending_mine", **b["h_r3"]).json() == []
    assert decide(api_client, b["h_r3"], req).status_code == 403

    after1 = _ok(decide(api_client, b["h_r1"], req))
    assert after1["current_step_order"] == 1  # 'all' step still waits for r2
    after2 = _ok(decide(api_client, b["h_r2"], req))
    assert after2["current_step_order"] == 2
    assert Notification.objects.filter(kind="approval_requested", user=b["r3"]).exists()

    final = _ok(decide(api_client, b["h_r3"], after2))
    assert final["status"] == "approved"
    assert [s["status"] for s in final["steps"]] == ["approved", "approved"]
    assert Notification.objects.filter(kind="approval_decided", user=b["s"]).exists()
    assert AuditLog.objects.filter(action="approval_decided").count() == 3

    done = _ok(api_client.post(f"{APPROVALS_URL}{req['id']}/complete/", **b["h_s"]), 200)
    assert done["status"] == "completed"


def test_any_step_needs_one_approval(api_client, board):
    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("any", [b["r1"], b["r2"]])]))
    final = _ok(decide(api_client, b["h_r2"], req))
    assert final["status"] == "approved"
    # the other slot can no longer act
    assert decide(api_client, b["h_r1"], req).status_code == 409


@pytest.mark.parametrize("decision", ["rejected", "returned"])
def test_reject_or_return_ends_request(api_client, board, decision):
    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"],
                               [("all", [b["r1"]]), ("all", [b["r2"]])]))
    final = _ok(decide(api_client, b["h_r1"], req, decision))
    assert final["status"] == decision
    assert [s["status"] for s in final["steps"]] == [decision, "cancelled"]


# --- request creation rules ----------------------------------------------------------

def test_only_sender_requests(api_client, board):
    b = board
    assert request_approval(api_client, b["h_r1"], b["corr"]["id"], [("all", [b["r2"]])]).status_code == 403


def test_approvers_must_be_participants(api_client, board):
    b = board
    resp = request_approval(api_client, b["h_s"], b["corr"]["id"], [("all", [b["r1"], b["o"]])])
    assert resp.status_code == 400
    assert resp.json()["not_participants"] == [str(b["o"].id)]


def test_requester_cannot_self_approve(api_client, board):
    b = board
    assert request_approval(api_client, b["h_s"], b["corr"]["id"], [("all", [b["s"]])]).status_code == 400


def test_one_pending_request_per_correspondence(api_client, board):
    b = board
    _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("all", [b["r1"]])]))
    assert request_approval(api_client, b["h_s"], b["corr"]["id"], [("all", [b["r2"]])]).status_code == 409


def test_cancel_by_requester_only(api_client, board):
    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("all", [b["r1"]])]))
    assert api_client.post(f"{APPROVALS_URL}{req['id']}/cancel/", **b["h_r1"]).status_code == 403
    assert _ok(api_client.post(f"{APPROVALS_URL}{req['id']}/cancel/", **b["h_s"]), 200)["status"] == "cancelled"
    assert decide(api_client, b["h_r1"], req).status_code == 409


# --- content binding ----------------------------------------------------------------

def test_decision_records_the_content_version(api_client, board):
    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("all", [b["r1"]])]))
    assert req["content_hash"]
    _ok(decide(api_client, b["h_r1"], req))
    d = ApprovalDecision.objects.get()
    assert __import__("base64").b64encode(bytes(d.content_hash)).decode() == req["content_hash"]


def test_unknown_decision_is_refused(api_client, board):
    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("all", [b["r1"]])]))
    assert decide(api_client, b["h_r1"], req, "maybe").status_code == 400


def test_duplicate_decision_is_impossible(api_client, board):
    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("all", [b["r1"], b["r2"]])]))
    _ok(decide(api_client, b["h_r1"], req))
    assert decide(api_client, b["h_r1"], req).status_code == 403
    first = ApprovalDecision.objects.get()
    with pytest.raises(IntegrityError):
        ApprovalDecision.objects.create(
            request=first.request, step=first.step, slot_user=first.slot_user, approver=first.approver,
            decision="approved", content_hash=first.content_hash,
        )


# --- delegation ------------------------------------------------------------------------

def _delegate(api_client, headers, delegate, hours=24):
    now = timezone.now()
    return api_client.post(
        f"{APPROVALS_URL}delegations/",
        {"delegate_id": str(delegate.id), "starts_at": (now - timedelta(minutes=1)).isoformat(),
         "ends_at": (now + timedelta(hours=hours)).isoformat()},
        format="json", **headers,
    )


def test_delegate_who_is_participant_can_decide(api_client, board):
    b = board
    _ok(_delegate(api_client, b["h_r1"], b["r2"]))
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("all", [b["r1"]])]))
    pending = api_client.get(f"{APPROVALS_URL}?box=pending_mine", **b["h_r2"]).json()
    assert pending and pending[0]["my_slot"] == {"slot_user_id": str(b["r1"].id), "delegated": True}
    final = _ok(decide(api_client, b["h_r2"], req))
    assert final["status"] == "approved"
    d = ApprovalDecision.objects.get()
    assert d.slot_user_id == b["r1"].id and d.approver_id == b["r2"].id and d.delegation_id


def test_delegation_never_grants_content_access(api_client, board):
    b = board
    _ok(_delegate(api_client, b["h_r1"], b["o"]))  # outsider
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("all", [b["r1"]])]))
    assert api_client.get(f"{APPROVALS_URL}?box=pending_mine", **b["h_o"]).json() == []
    assert api_client.get(f"{APPROVALS_URL}{req['id']}/", **b["h_o"]).status_code == 403
    assert decide(api_client, b["h_o"], req).status_code == 403
    assert not Notification.objects.filter(kind="approval_requested", user=b["o"]).exists()


def test_revoked_or_expired_delegation_is_inert(api_client, board):
    b = board
    d = _ok(_delegate(api_client, b["h_r1"], b["r2"]))
    _ok(api_client.post(f"{APPROVALS_URL}delegations/{d['id']}/revoke/", **b["h_r1"]), 200)
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("all", [b["r1"]])]))
    assert decide(api_client, b["h_r2"], req).status_code == 403
    ApprovalDelegation.objects.create(
        delegator=b["r1"], delegate=b["r2"], starts_at=timezone.now() - timedelta(days=2),
        ends_at=timezone.now() - timedelta(days=1),
    )
    assert decide(api_client, b["h_r2"], req).status_code == 403


def test_delegation_validation(api_client, board):
    b = board
    assert _delegate(api_client, b["h_r1"], b["r1"]).status_code == 400
    assert _delegate(api_client, b["h_r1"], b["r2"], hours=24 * 120).status_code == 400


# --- privacy gates ------------------------------------------------------------------------

@pytest.mark.parametrize("role", ["branch_manager", "sys_admin"])
def test_privileged_roles_see_nothing(api_client, user_factory, branch_a, board, role):
    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("all", [b["r1"]])]))
    boss = make_employee(user_factory, f"c_boss_{role}", branch_a)
    if role == "branch_manager":
        assign_role(boss, role, institute=branch_a.institute, branch=branch_a)
    else:
        assign_role(boss, role)
    h = auth(api_client, boss.username)
    assert api_client.get(f"{APPROVALS_URL}{req['id']}/", **h).status_code == 403
    assert api_client.get(f"{APPROVALS_URL}?box=pending_mine", **h).json() == []
    assert api_client.get(f"{APPROVALS_URL}?box=correspondence&correspondence_id={b['corr']['id']}",
                          **h).status_code == 403
    assert decide(api_client, h, req).status_code == 403
    assert api_client.post(f"{APPROVALS_URL}{req['id']}/cancel/", **h).status_code == 403
    assert ApprovalRequest.objects.get(id=req["id"]).status == "pending"


# --- templates ------------------------------------------------------------------------------

def test_workflow_template_resolves_role_holders_among_participants(api_client, user_factory, branch_a, board):
    b = board
    head = make_employee(user_factory, "c_head", branch_a)
    assign_role(head, "dept_head", institute=branch_a.institute, branch=branch_a)
    h_head = auth(api_client, "c_head")
    # employees cannot define workflows
    body = {"name": "اعتماد مدير الفرع", "branch_id": str(branch_a.id),
            "steps": [{"type": "any", "approver_selectors": [{"role": "branch_manager", "scope": "sender_branch"}]}]}
    assert api_client.post(f"{APPROVALS_URL}workflows/", body, format="json", **b["h_s"]).status_code == 403
    wf = _ok(api_client.post(f"{APPROVALS_URL}workflows/", body, format="json", **h_head))

    # r2 is the branch manager and a cc participant → resolves to r2
    assign_role(b["r2"], "branch_manager", branch=branch_a)
    req = _ok(api_client.post(APPROVALS_URL, {"correspondence_id": b["corr"]["id"], "workflow_id": wf["id"]},
                              format="json", **b["h_s"]))
    assert [a["user"]["id"] for a in req["steps"][0]["approvers"]] == [str(b["r2"].id)]


def test_workflow_role_holder_outside_participants_is_reported(api_client, user_factory, branch_a, board):
    b = board
    head = make_employee(user_factory, "c_head2", branch_a)
    assign_role(head, "dept_head", institute=branch_a.institute, branch=branch_a)
    mgr = make_employee(user_factory, "c_mgr2", branch_a)
    assign_role(mgr, "branch_manager", branch=branch_a)
    body = {"name": "x", "steps": [{"type": "any", "approver_selectors": [
        {"role": "branch_manager", "scope": "sender_branch"}]}]}
    # central template needs a central approvals.define → dept_head scoped to branch is refused
    assert api_client.post(f"{APPROVALS_URL}workflows/", body, format="json",
                           **auth(api_client, "c_head2")).status_code == 403
    body["branch_id"] = str(branch_a.id)
    wf = _ok(api_client.post(f"{APPROVALS_URL}workflows/", body, format="json", **auth(api_client, "c_head2")))
    resp = api_client.post(APPROVALS_URL, {"correspondence_id": b["corr"]["id"], "workflow_id": wf["id"]},
                           format="json", **b["h_s"])
    assert resp.status_code == 400
    assert resp.json()["not_participants"] == [str(mgr.id)]
