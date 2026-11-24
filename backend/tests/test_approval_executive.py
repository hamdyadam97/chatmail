"""The executive decides directly (user decision 2026-11-24): an executive who
is an approver of a later step sees the request from the start (notified
«بانتظار موافقة المدير المباشر»), and may approve or reject it right away —
the earlier open steps close as "skipped" and their approvers are told.
Waiting for the direct manager stays the default."""
import base64

import pytest

from apps.approvals.models import ApprovalRequest
from apps.audit.models import AuditLog
from apps.notifications.models import Notification

from .conftest import DEFAULT_PASSWORD
from .correspondence_utils import _blob_root, make_employee  # noqa: F401  (fixture)
from .messaging_utils import auth
from .test_signed_requests import _file, _png, org  # noqa: F401  (fixture)

pytestmark = pytest.mark.django_db
API = "/api/v1/approvals/"


def _sign_up(api_client, headers):
    api_client.put(f"{API}signature/", {"image": base64.b64encode(_png()).decode()}, format="json", **headers)


def _decide(api_client, headers, rid, decision="approved", **body):
    return api_client.post(f"{API}{rid}/decide/", {"decision": decision, **body}, format="json", **headers)


def test_executive_sees_it_at_once_and_approves_directly(api_client, org):
    h = org["h"]
    req = _file(api_client, org).json()
    rid = req["id"]
    # told at once, and it is in their «بانتظار قراري» marked as early
    assert Notification.objects.filter(user=org["ex"], kind="approval_awaiting_manager").count() == 1
    assert Notification.objects.filter(user=org["bm"], kind="approval_requested").count() == 1
    mine = api_client.get(f"{API}?box=pending_mine", **h["sr_exec"]).json()
    assert [r["id"] for r in mine] == [rid]
    assert mine[0]["my_slot"] is None and mine[0]["my_early_step"] == 2
    # the manager's view is unchanged
    bm_view = api_client.get(f"{API}{rid}/", **h["sr_bm"]).json()
    assert bm_view["my_slot"] and bm_view["my_early_step"] is None

    # before their turn: approve or reject only (no defer / return)
    assert _decide(api_client, h["sr_exec"], rid, "returned").status_code == 400
    assert api_client.post(f"{API}{rid}/defer/", {}, format="json", **h["sr_exec"]).status_code == 403

    _sign_up(api_client, h["sr_exec"])
    done = _decide(api_client, h["sr_exec"], rid, password=DEFAULT_PASSWORD, page=1)
    assert done.status_code == 201, done.content
    body = done.json()
    assert body["status"] == "approved" and body["signature_count"] == 1
    assert [s["status"] for s in body["steps"]] == ["skipped", "approved"]
    assert [e["kind"] for e in body["events"]] == ["skipped", "approved"]
    # the manager is told and can no longer decide; the requester gets the final outcome
    assert Notification.objects.filter(user=org["bm"], kind="approval_overridden").count() == 1
    assert Notification.objects.filter(user=org["emp"], kind="approval_approved").count() == 1
    _sign_up(api_client, h["sr_bm"])
    assert _decide(api_client, h["sr_bm"], rid, password=DEFAULT_PASSWORD, page=1).status_code == 409
    assert api_client.get(f"{API}?box=pending_mine", **h["sr_bm"]).json() == []
    log = AuditLog.objects.get(action="approval_decided")
    assert log.metadata["overridden"] is True and log.metadata["skipped"] == 1


def test_executive_rejects_directly(api_client, org):
    h = org["h"]
    rid = _file(api_client, org).json()["id"]
    r = _decide(api_client, h["sr_exec"], rid, "rejected", note="غير مبرر")
    assert r.status_code == 201, r.content
    assert r.json()["status"] == "rejected"
    assert [s["status"] for s in r.json()["steps"]] == ["skipped", "rejected"]
    assert Notification.objects.filter(user=org["emp"], kind="approval_rejected").count() == 1
    assert Notification.objects.filter(user=org["bm"], kind="approval_overridden").count() == 1


def test_waiting_is_still_the_normal_path(api_client, org):
    h = org["h"]
    rid = _file(api_client, org).json()["id"]
    for who in ("sr_bm", "sr_exec"):
        _sign_up(api_client, h[who])
    assert _decide(api_client, h["sr_bm"], rid, password=DEFAULT_PASSWORD, page=1).status_code == 201
    view = api_client.get(f"{API}{rid}/", **h["sr_exec"]).json()
    assert view["my_slot"] and view["my_early_step"] is None  # now simply their turn
    done = _decide(api_client, h["sr_exec"], rid, password=DEFAULT_PASSWORD, page=1).json()
    assert done["status"] == "approved" and [s["status"] for s in done["steps"]] == ["approved", "approved"]
    assert not Notification.objects.filter(kind="approval_overridden").exists()


def test_only_the_executive_may_jump_ahead(api_client, user_factory, branch_a, org):
    """A non-executive approver of a later step waits for their turn."""
    h = org["h"]
    other = make_employee(user_factory, "sr_named", branch_a)
    wf = api_client.post(f"{API}workflows/", {
        "name": "طلب زيارة", "signable": True,
        "steps": [
            {"type": "any", "approver_selectors": [{"role": "branch_manager", "scope": "sender_branch"}]},
            {"type": "any", "approver_selectors": [{"user": str(other.id)}]},
        ],
    }, format="json", **h["sr_admin"]).json()
    rid = _file(api_client, {**org, "wf": wf}).json()["id"]
    h_other = auth(api_client, "sr_named")
    assert api_client.get(f"{API}{rid}/", **h_other).json()["my_early_step"] is None
    assert _decide(api_client, h_other, rid, "rejected").status_code == 403
    assert not Notification.objects.filter(user=other, kind="approval_awaiting_manager").exists()
    assert ApprovalRequest.objects.get(id=rid).status == "pending"


def test_admin_edits_a_request_type_and_bad_role_scopes_are_refused(api_client, org):
    """«تعديل» نوع الطلب: الطلبات القائمة تبقى بخطواتها، والجديدة تأخذ المعدَّلة.
    ولا تُقبل توليفة لا تجد أحدًا أبدًا (مثل «مدير الفرع — مركزي»)."""
    h = org["h"]
    url = f"{API}workflows/"
    bad = api_client.post(url, {"name": "طلب اجازة", "signable": True, "steps": [
        {"type": "any", "approver_selectors": [{"role": "branch_manager", "scope": "central"}]}]}, format="json", **h["sr_admin"])
    assert bad.status_code == 400 and "فرع مقدّم الطلب" in bad.content.decode()

    old = _file(api_client, org).json()  # filed on the 2-step type
    wid = org["wf"]["id"]
    one_step = [{"type": "any", "approver_selectors": [{"role": "executive", "scope": "central"}]}]
    assert api_client.patch(f"{url}{wid}/", {"steps": one_step}, format="json", **h["sr_emp"]).status_code == 403
    assert api_client.patch(f"{url}{wid}/", {"steps": [{"type": "any", "approver_selectors": [
        {"role": "executive", "scope": "sender_branch"}]}]}, format="json", **h["sr_admin"]).status_code == 400
    r = api_client.patch(f"{url}{wid}/", {"name": "طلب صرف عاجل", "steps": one_step}, format="json", **h["sr_admin"])
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["name"] == "طلب صرف عاجل" and body["version"] == 2 and len(body["steps"]) == 1
    assert AuditLog.objects.filter(action="approval_workflow_updated").count() == 1

    # the request filed before keeps its two steps; a new one has one
    assert len(api_client.get(f"{API}{old['id']}/", **h["sr_emp"]).json()["steps"]) == 2
    new = _file(api_client, org).json()
    assert len(new["steps"]) == 1 and new["workflow_name"] == "طلب صرف عاجل"
