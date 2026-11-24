"""Following a request through its steps (user decision 2026-11-24): a
distinct notification for each outcome and each finished step, an optional
sealed note with a decision, «تأجيل» that keeps the request with the
approver, and «تعديل وإعادة إرسال» of a returned request."""
import base64

import pytest

from apps.approvals.models import ApprovalEvent, ApprovalRequest
from apps.audit.models import AuditLog
from apps.notifications.models import Notification

from .approvals_utils import APPROVALS_URL, decide, request_approval
from .conftest import DEFAULT_PASSWORD
from .correspondence_utils import (  # noqa: F401  (fixtures)
    _blob_root,
    make_employee,
    office,
    prepare_and_send,
)
from .messaging_utils import auth
from .test_signed_requests import _download, _file, _pages, _png, org  # noqa: F401  (fixture)

pytestmark = pytest.mark.django_db

API = APPROVALS_URL


@pytest.fixture
def board(api_client, user_factory, branch_a, office):
    r3 = make_employee(user_factory, "f_rcpt3", branch_a)
    office["r3"] = r3
    office["h_r3"] = auth(api_client, "f_rcpt3")
    office["corr"] = prepare_and_send(api_client, office["h_s"], [office["r1"]], [office["r2"], r3])
    return office


def _ok(resp, code=201):
    assert resp.status_code == code, resp.content
    return resp.json()


def _kinds(user):
    return list(Notification.objects.filter(user=user).order_by("created_at").values_list("kind", flat=True))


def _act(client, headers, req, action, **body):
    return client.post(f"{APPROVALS_URL}{req['id']}/{action}/", body, format="json", **headers)


def test_requester_is_told_of_every_step_and_the_final_approval(api_client, board):
    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("any", [b["r1"]]), ("any", [b["r2"]])]))
    _ok(decide(api_client, b["h_r1"], req))
    assert _kinds(b["s"]) == ["approval_step_approved"]
    _ok(decide(api_client, b["h_r2"], req))
    assert _kinds(b["s"]) == ["approval_step_approved", "approval_approved"]
    assert Notification.objects.get(user=b["s"], kind="approval_approved").title_generic == "اعتُمد طلبك نهائيًا"


def test_return_with_a_note_then_resubmit_resumes_at_the_returning_step(api_client, board):
    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"],
                               [("any", [b["r1"]]), ("all", [b["r2"], b["r3"]])]))
    _ok(decide(api_client, b["h_r1"], req))
    _ok(decide(api_client, b["h_r2"], req))  # step 2 needs both; r2 approves, r3 returns
    back = _ok(api_client.post(f"{APPROVALS_URL}{req['id']}/decide/", {"decision": "returned", "note": "ناقص فاتورة"},
                               format="json", **b["h_r3"]))
    assert back["status"] == "returned" and back["can_resubmit"] is False  # r3 is not the requester
    assert _kinds(b["s"])[-1] == "approval_returned"
    # the note: on the request page for its readers, sealed in the database, never in the notification
    mine = _ok(api_client.get(f"{APPROVALS_URL}{req['id']}/", **b["h_s"]), 200)
    assert mine["can_resubmit"] is True
    assert [(e["kind"], e["note"]) for e in mine["events"]] == [("approved", ""), ("approved", ""), ("returned", "ناقص فاتورة")]
    event = ApprovalEvent.objects.get(kind="returned")
    assert "ناقص فاتورة".encode() not in bytes(event.note_enc)
    assert not Notification.objects.filter(title_generic__contains="فاتورة").exists()
    assert not AuditLog.objects.filter(metadata__icontains="فاتورة").exists()

    # only the requester resubmits, and only a returned request
    assert _act(api_client, b["h_r1"], req, "resubmit").status_code == 403
    before = Notification.objects.filter(kind="approval_requested").count()
    again = _ok(_act(api_client, b["h_s"], req, "resubmit", note="أرفقت الفاتورة في رد على المراسلة"), 200)
    assert again["status"] == "pending" and again["current_step_order"] == 2 and again["round"] == 1
    assert [s["status"] for s in again["steps"]] == ["approved", "active"]
    step2 = {a["user"]["id"]: a["decision"] for a in again["steps"][1]["approvers"]}
    assert step2[str(b["r2"].id)]["decision"] == "approved" and step2[str(b["r3"].id)] is None  # r2's approval stays
    # only r3 (who has not decided) is asked again
    asked = Notification.objects.filter(kind="approval_requested").order_by("-created_at")[: Notification.objects.filter(
        kind="approval_requested").count() - before]
    assert [n.user_id for n in asked] == [b["r3"].id]
    assert again["events"][-1]["kind"] == "resubmitted" and again["events"][-1]["note"].startswith("أرفقت")
    assert _act(api_client, b["h_s"], req, "resubmit").status_code == 409  # pending again

    final = _ok(decide(api_client, b["h_r3"], req))
    assert final["status"] == "approved"
    assert AuditLog.objects.filter(action="approval_resubmitted").count() == 1


def test_rejection_is_final(api_client, board):
    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("any", [b["r1"]])]))
    _ok(api_client.post(f"{APPROVALS_URL}{req['id']}/decide/", {"decision": "rejected", "note": "خارج الميزانية"},
                        format="json", **b["h_r1"]))
    assert _kinds(b["s"]) == ["approval_rejected"]
    assert _act(api_client, b["h_s"], req, "resubmit").status_code == 409


def test_defer_keeps_the_request_with_the_approver(api_client, board):
    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("any", [b["r1"]])]))
    assert _act(api_client, b["h_r2"], req, "defer").status_code == 403  # not an approver
    assert _act(api_client, b["h_s"], req, "defer").status_code == 403
    later = _ok(_act(api_client, b["h_r1"], req, "defer", note="بعد اجتماع الأحد"), 200)
    assert later["status"] == "pending"
    assert later["steps"][0]["approvers"][0]["deferred_at"]
    assert later["events"][-1]["kind"] == "deferred" and later["events"][-1]["note"] == "بعد اجتماع الأحد"
    assert _kinds(b["s"]) == ["approval_deferred"]
    # still waiting for r1, who decides later
    assert [r["id"] for r in api_client.get(f"{APPROVALS_URL}?box=pending_mine", **b["h_r1"]).json()] == [req["id"]]
    done = _ok(decide(api_client, b["h_r1"], req))
    assert done["status"] == "approved" and done["steps"][0]["approvers"][0]["deferred_at"] is None
    assert _act(api_client, b["h_r1"], req, "defer").status_code == 409  # decided


def test_resubmitting_a_new_document_restarts_the_signatures(api_client, org):
    from django.core.files.uploadedfile import SimpleUploadedFile

    h = org["h"]
    rid = _file(api_client, org).json()["id"]
    for who in ("sr_bm", "sr_exec"):
        api_client.put(f"{API}signature/", {"image": base64.b64encode(_png()).decode()}, format="json", **h[who])
    signed = _ok(api_client.post(f"{API}{rid}/decide/", {"decision": "approved", "password": DEFAULT_PASSWORD, "page": 1},
                                 format="json", **h["sr_bm"]))
    old_code = signed["steps"][0]["approvers"][0]["decision"]["verify_code"]
    _ok(api_client.post(f"{API}{rid}/decide/", {"decision": "returned", "note": "أضف عرض السعر"},
                        format="json", **h["sr_exec"]))

    # resubmit with a new two-page document: everyone signs the new file from step 1
    again = api_client.post(f"{API}{rid}/resubmit/", {
        "note": "أضفت عرض السعر", "file": SimpleUploadedFile("expense-v2.pdf", _pages(2), content_type="application/pdf"),
    }, format="multipart", **h["sr_emp"])
    assert again.status_code == 200, again.content
    r = again.json()
    assert r["status"] == "pending" and r["round"] == 2 and r["current_step_order"] == 1
    assert r["source_file"]["name"] == "expense-v2.pdf" and r["signed_file"] is None and r["signature_count"] == 0
    assert r["page_count"] == 2 and r["page_signatures"] == {} and r["signature_boxes"] == []
    assert all(a["decision"] is None for s in r["steps"] for a in s["approvers"])
    assert r["events"][-1]["kind"] == "resubmitted_file"
    # the approvers read the new file; outsiders do not
    assert _download(api_client, h["sr_bm"], r["source_file"]["id"]).status_code == 200
    assert _download(api_client, h["sr_out"], r["source_file"]["id"]).status_code == 403
    # the old signature still verifies, marked as an earlier copy
    got = api_client.get(f"{API}verify/?code={old_code}", **h["sr_out"]).json()
    assert got["valid"] and got["superseded"] is True

    for who in ("sr_bm", "sr_exec"):
        _ok(api_client.post(f"{API}{rid}/decide/", {"decision": "approved", "password": DEFAULT_PASSWORD, "page": 2},
                            format="json", **h[who]))
    done = api_client.get(f"{API}{rid}/", **h["sr_emp"]).json()
    assert done["status"] == "approved" and done["signature_count"] == 2 and done["page_signatures"] == {"2": 2}
    new_code = done["steps"][0]["approvers"][0]["decision"]["verify_code"]
    assert new_code != old_code
    assert api_client.get(f"{API}verify/?code={new_code}", **h["sr_out"]).json()["superseded"] is False
    assert ApprovalRequest.objects.get(id=rid).round == 2


def test_a_new_document_needs_a_filed_request(api_client, board):
    from django.core.files.uploadedfile import SimpleUploadedFile

    b = board
    req = _ok(request_approval(api_client, b["h_s"], b["corr"]["id"], [("any", [b["r1"]])]))
    _ok(decide(api_client, b["h_r1"], req, "returned"))
    resp = api_client.post(f"{APPROVALS_URL}{req['id']}/resubmit/", {
        "file": SimpleUploadedFile("x.pdf", _pages(1), content_type="application/pdf")}, format="multipart", **b["h_s"])
    assert resp.status_code == 400

