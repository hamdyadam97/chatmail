"""Signed requests (user decision 2026-11-21): an employee files a request
document of a fixed type; each approver approves with password and their
saved signature, which is stamped on the PDF's last page."""
import base64
import io

import pytest
from pypdf import PdfReader

from apps.approvals.models import ApprovalRequest, UserSignature
from apps.audit.models import AuditLog

from .conftest import DEFAULT_PASSWORD, assign_role
from .correspondence_utils import _blob_root, make_employee  # noqa: F401  (autouse blob dir)
from .messaging_utils import auth

pytestmark = pytest.mark.django_db

API = "/api/v1/approvals/"


def _png(size=(600, 200), line=True) -> bytes:
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", size, (0, 0, 0, 0))
    if line:
        ImageDraw.Draw(img).line([(20, 150), (200, 40), (580, 120)], fill=(0, 0, 120, 255), width=8)
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


def _scan() -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (1240, 1754), "white").save(out, "JPEG")
    return out.getvalue()


@pytest.fixture
def org(api_client, user_factory, branch_a, branch_b):
    admin = user_factory("sr_admin", membership_unit=branch_a)
    assign_role(admin, "sys_admin")
    emp = make_employee(user_factory, "sr_emp", branch_a)
    bm = make_employee(user_factory, "sr_bm", branch_a)
    assign_role(bm, "branch_manager", institute=branch_a.institute, branch=branch_a)
    ex = make_employee(user_factory, "sr_exec", branch_a)
    assign_role(ex, "executive")
    outsider = make_employee(user_factory, "sr_out", branch_b)
    h = {n: auth(api_client, n) for n in ("sr_admin", "sr_emp", "sr_bm", "sr_exec", "sr_out")}
    wf = api_client.post(f"{API}workflows/", {
        "name": "طلب صرف", "signable": True,
        "steps": [
            {"type": "any", "approver_selectors": [{"role": "branch_manager", "scope": "sender_branch"}]},
            {"type": "any", "approver_selectors": [{"role": "executive", "scope": "central"}]},
        ],
    }, format="json", **h["sr_admin"])
    assert wf.status_code == 201, wf.content
    return {"emp": emp, "bm": bm, "ex": ex, "out": outsider, "h": h, "wf": wf.json()}


def _file(api_client, org, data=None, name="expense.jpg"):
    from django.core.files.uploadedfile import SimpleUploadedFile

    return api_client.post(f"{API}file-request/", {
        "workflow_id": org["wf"]["id"], "title": "صرف مستلزمات", "note": "مرفق الطلب",
        "file": SimpleUploadedFile(name, data or _scan(), content_type="image/jpeg"),
    }, format="multipart", **org["h"]["sr_emp"])


def _download(api_client, headers, file_id):
    return api_client.get(f"/api/v1/attachments/{file_id}/", **headers)


def test_file_sign_and_download(api_client, org):
    h = org["h"]
    types = api_client.get(f"{API}request-types/", **h["sr_emp"]).json()
    assert [t["name"] for t in types] == ["طلب صرف"] and types[0]["signable"]

    r = _file(api_client, org)
    assert r.status_code == 201, r.content
    req = r.json()
    assert req["signable"] and req["title"] == "طلب صرف: صرف مستلزمات" and req["source_file"]["name"] == "expense.pdf"
    assert req["signed_file"] is None and req["signature_count"] == 0 and req["page_count"] == 1
    rid = req["id"]

    # the branch manager: no saved signature → refused; wrong password → refused
    decide = lambda who, **b: api_client.post(f"{API}{rid}/decide/", {"decision": "approved", **b}, format="json", **h[who])
    assert decide("sr_bm", password=DEFAULT_PASSWORD).status_code == 400
    sig = api_client.put(f"{API}signature/", {"image": base64.b64encode(_png()).decode()}, format="json", **h["sr_bm"])
    assert sig.status_code == 200 and sig.json()["has_signature"]
    assert decide("sr_bm", password="wrong").status_code == 400
    assert decide("sr_bm", password=DEFAULT_PASSWORD).status_code == 400  # the page must be chosen
    assert decide("sr_bm", password=DEFAULT_PASSWORD, page=2).status_code == 400  # one page only
    first = decide("sr_bm", password=DEFAULT_PASSWORD, page=1)
    assert first.status_code == 201, first.content
    assert first.json()["signature_count"] == 1 and first.json()["status"] == "pending"

    api_client.put(f"{API}signature/", {"image": "data:image/png;base64," + base64.b64encode(_png()).decode()},
                   format="json", **h["sr_exec"])
    second = decide("sr_exec", password=DEFAULT_PASSWORD, page=1)
    assert second.status_code == 201, second.content
    done = second.json()
    assert done["status"] == "approved" and done["signature_count"] == 2

    # the signed PDF: one page, both signatures, readable by the requester and approvers only
    pdf = _download(api_client, h["sr_emp"], done["signed_file"]["id"])
    assert pdf.status_code == 200
    reader = PdfReader(io.BytesIO(b"".join(pdf.streaming_content) if hasattr(pdf, "streaming_content") else pdf.content))
    assert len(reader.pages) == 1
    text = reader.pages[0].extract_text()
    assert text.count(ApprovalRequest.objects.get(id=rid).correspondence.reference_number) == 2
    assert _download(api_client, h["sr_exec"], done["signed_file"]["id"]).status_code == 200
    assert _download(api_client, h["sr_out"], done["signed_file"]["id"]).status_code == 403
    assert AuditLog.objects.filter(action="approval_decided", metadata__signed=True).count() == 2
    # the approver finds it again after signing («وصلتني»)
    assert rid in [x["id"] for x in api_client.get(f"{API}?box=received", **h["sr_bm"]).json()]
    assert rid not in [x["id"] for x in api_client.get(f"{API}?box=received", **h["sr_out"]).json()]


def _pages(n: int) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    first, *rest = [Image.new("RGB", (1240, 1754), "white") for _ in range(n)]
    first.save(out, "PDF", save_all=True, append_images=rest)
    return out.getvalue()


def test_each_approver_signs_the_page_they_choose(api_client, org):
    from django.core.files.uploadedfile import SimpleUploadedFile

    h = org["h"]
    r = api_client.post(f"{API}file-request/", {
        "workflow_id": org["wf"]["id"], "title": "عقد",
        "file": SimpleUploadedFile("contract.pdf", _pages(3), content_type="application/pdf")},
        format="multipart", **h["sr_emp"])
    assert r.status_code == 201 and r.json()["page_count"] == 3
    rid = r.json()["id"]
    for who, page in (("sr_bm", 2), ("sr_exec", 3)):
        api_client.put(f"{API}signature/", {"image": base64.b64encode(_png()).decode()}, format="json", **h[who])
        resp = api_client.post(f"{API}{rid}/decide/", {"decision": "approved", "password": DEFAULT_PASSWORD, "page": page},
                               format="json", **h[who])
        assert resp.status_code == 201, resp.content
    done = api_client.get(f"{API}{rid}/", **h["sr_emp"]).json()
    assert done["page_signatures"] == {"2": 1, "3": 1}
    pdf = _download(api_client, h["sr_emp"], done["signed_file"]["id"])
    reader = PdfReader(io.BytesIO(b"".join(pdf.streaming_content) if hasattr(pdf, "streaming_content") else pdf.content))
    ref = ApprovalRequest.objects.get(id=rid).correspondence.reference_number
    assert [reader.pages[i].extract_text().count(ref) for i in range(3)] == [0, 1, 1]

    # each box carries its verification code; any employee checks it (no content returned)
    codes = {a["user"]["id"]: a["decision"]["verify_code"] for s in done["steps"] for a in s["approvers"]}
    bm_code = codes[str(org["bm"].id)]
    assert len(bm_code) == 9 and bm_code[4] == "-"
    assert bm_code in reader.pages[1].extract_text() and codes[str(org["ex"].id)] in reader.pages[2].extract_text()
    got = api_client.get(f"{API}verify/?code={bm_code.lower().replace('-', '')}", **h["sr_out"]).json()
    assert got["valid"] and got["signer"] == org["bm"].full_name and got["page"] == 2 and got["reference_number"] == ref
    assert got["request_status"] == "approved" and "title" not in got and "body" not in str(got)
    assert api_client.get(f"{API}verify/?code=AAAA-BBBB", **h["sr_out"]).json() == {"valid": False}
    assert api_client.get(f"{API}verify/?code=", **h["sr_out"]).json() == {"valid": False}
    assert AuditLog.objects.filter(action="signature_verified").count() == 3


def test_reject_needs_no_signature_and_types_are_admin_defined(api_client, org):
    h = org["h"]
    rid = _file(api_client, org).json()["id"]
    r = api_client.post(f"{API}{rid}/decide/", {"decision": "rejected"}, format="json", **h["sr_bm"])
    assert r.status_code == 201 and r.json()["status"] == "rejected" and r.json()["signed_file"] is None
    # an employee cannot define request types
    bad = api_client.post(f"{API}workflows/", {"name": "x", "signable": True, "steps": [
        {"type": "any", "approver_selectors": [{"role": "executive", "scope": "central"}]}]}, format="json", **h["sr_emp"])
    assert bad.status_code == 403
    # retired types disappear from «طلب جديد»
    assert api_client.patch(f"{API}workflows/{org['wf']['id']}/", {"is_active": False}, format="json",
                            **h["sr_admin"]).status_code == 200
    assert api_client.get(f"{API}request-types/", **h["sr_emp"]).json() == []


def test_approver_places_the_signature_where_they_choose(api_client, org):
    h = org["h"]
    rid = _file(api_client, org).json()["id"]
    for who in ("sr_bm", "sr_exec"):
        api_client.put(f"{API}signature/", {"image": base64.b64encode(_png()).decode()}, format="json", **h[who])
    decide = lambda who, **b: api_client.post(f"{API}{rid}/decide/", {"decision": "approved", "password": DEFAULT_PASSWORD,
                                                                       "page": 1, **b}, format="json", **h[who])
    assert decide("sr_bm", x=500, y=10).status_code == 400  # off the page (A4 ≈ 595 wide, box 165)
    assert decide("sr_bm", x=40).status_code == 400  # x without y
    first = decide("sr_bm", x=40, y=120)
    assert first.status_code == 201, first.content
    assert first.json()["signature_boxes"] == [{"page": 1, "x": 40.0, "y": 120.0, "w": 165.0, "h": 104.0}]
    assert first.json()["signature_box"] == {"w": 165.0, "h": 104.0}
    assert decide("sr_exec", x=100, y=150).status_code == 400  # would cover the first signature
    second = decide("sr_exec", x=300, y=120)
    assert second.status_code == 201, second.content
    assert [b["x"] for b in second.json()["signature_boxes"]] == [40.0, 300.0]


def test_type_signed_by_a_named_employee_goes_to_that_person_only(api_client, user_factory, org):
    from apps.accounts.models import User

    h = org["h"]
    # a second executive exists — a role step would ask both; a named step asks one
    other = make_employee(user_factory, "sr_exec2", org["emp"].memberships.first().branch)
    assign_role(other, "executive")
    User.objects.filter(id=org["ex"].id).update(full_name="وسام أبوخضر")
    wf = api_client.post(f"{API}workflows/", {"name": "طلب إجازة", "signable": True, "steps": [
        {"type": "any", "approver_selectors": [{"user": str(org["ex"].id)}]}]}, format="json", **h["sr_admin"])
    assert wf.status_code == 201, wf.content
    assert wf.json()["steps"][0]["approver_selectors"] == [{"user": str(org["ex"].id), "name": "وسام أبوخضر"}]
    from django.core.files.uploadedfile import SimpleUploadedFile

    r = api_client.post(f"{API}file-request/", {
        "workflow_id": wf.json()["id"], "title": "إجازة",
        "file": SimpleUploadedFile("leave.jpg", _scan(), content_type="image/jpeg")}, format="multipart", **h["sr_emp"])
    assert r.status_code == 201, r.content
    approvers = [a["user"]["id"] for a in r.json()["steps"][0]["approvers"]]
    assert approvers == [str(org["ex"].id)]
    # an unknown or bad id is refused
    bad = api_client.post(f"{API}workflows/", {"name": "x", "signable": True, "steps": [
        {"type": "any", "approver_selectors": [{"user": "nope"}]}]}, format="json", **h["sr_admin"])
    assert bad.status_code == 400


def test_requester_removes_an_approver_who_then_no_longer_sees_it(api_client, user_factory, org):
    from django.core.files.uploadedfile import SimpleUploadedFile

    from apps.notifications.models import Notification

    h = org["h"]
    extra = make_employee(user_factory, "sr_exec2", org["emp"].memberships.first().branch)
    assign_role(extra, "executive")
    h_extra = auth(api_client, "sr_exec2")
    wf = api_client.post(f"{API}workflows/", {"name": "طلب سلفة", "signable": True, "steps": [
        {"type": "any", "approver_selectors": [{"role": "executive", "scope": "central"}]}]}, format="json", **h["sr_admin"])
    r = api_client.post(f"{API}file-request/", {
        "workflow_id": wf.json()["id"], "title": "سلفة",
        "file": SimpleUploadedFile("a.jpg", _scan(), content_type="image/jpeg")}, format="multipart", **h["sr_emp"])
    req = r.json()
    corr_id = req["correspondence"]["id"]
    assert {a["user"]["id"] for a in req["steps"][0]["approvers"]} == {str(org["ex"].id), str(extra.id)}
    assert Notification.objects.filter(user=extra, ref_id=req["id"]).exists()
    assert corr_id in str(api_client.get("/api/v1/correspondences/?folder=inbox", **h_extra).json())

    url = f"{API}{req['id']}/remove-approver/"
    assert api_client.post(url, {"approver_id": str(extra.id)}, format="json", **h["sr_exec"]).status_code == 403
    done = api_client.post(url, {"approver_id": str(extra.id)}, format="json", **h["sr_emp"])
    assert done.status_code == 200, done.content
    assert [a["user"]["id"] for a in done.json()["steps"][0]["approvers"]] == [str(org["ex"].id)]
    # gone for the removed person: the request, its correspondence, the inbox and the bell
    assert api_client.get(f"{API}{req['id']}/", **h_extra).status_code == 403
    assert api_client.get(f"/api/v1/correspondences/{corr_id}/", **h_extra).status_code in (403, 404)
    assert api_client.get(f"{API}?box=pending_mine", **h_extra).json() == []
    inbox = api_client.get("/api/v1/correspondences/?folder=inbox", **h_extra).json()
    assert corr_id not in str(inbox)
    assert not Notification.objects.filter(user=extra, ref_id__in=[req["id"], corr_id]).exists()
    # the last approver of a step cannot be removed (cancel instead); the other still decides
    last = api_client.post(url, {"approver_id": str(org["ex"].id)}, format="json", **h["sr_emp"])
    assert last.status_code == 400
    assert api_client.get(f"{API}?box=pending_mine", **h["sr_exec"]).json()[0]["id"] == req["id"]


def test_cancelled_request_stays_listed_for_its_approvers_only(api_client, org):
    h = org["h"]
    rid = _file(api_client, org).json()["id"]
    assert api_client.get(f"{API}?box=cancelled_mine", **h["sr_bm"]).json() == []
    assert api_client.post(f"{API}{rid}/cancel/", **h["sr_emp"]).status_code == 200
    listed = api_client.get(f"{API}?box=cancelled_mine", **h["sr_bm"]).json()
    assert [r["id"] for r in listed] == [rid] and listed[0]["status"] == "cancelled" and listed[0]["my_slot"] is None
    assert api_client.get(f"{API}?box=pending_mine", **h["sr_bm"]).json() == []
    assert api_client.get(f"{API}?box=cancelled_mine", **h["sr_out"]).json() == []


def test_role_assignments_search_by_arabic_name(api_client, org):
    from apps.accounts.models import User

    User.objects.filter(id=org["ex"].id).update(full_name="صقر الغامدي")
    rows = api_client.get("/api/v1/roles/assignments/?user=صقر", **org["h"]["sr_admin"]).json()
    assert {r["user"] for r in rows} == {"sr_exec"}
    by_role = api_client.get("/api/v1/roles/assignments/?user=مدير تنفيذي", **org["h"]["sr_admin"]).json()
    assert "sr_exec" in {r["user"] for r in by_role}


def test_bad_files_and_signatures_are_refused(api_client, org):
    h = org["h"]
    assert _file(api_client, org, data=b"not a pdf at all", name="x.docx").status_code == 400
    assert api_client.put(f"{API}signature/", {"image": base64.b64encode(_png(line=False)).decode()},
                          format="json", **h["sr_bm"]).status_code == 400  # empty drawing
    assert api_client.put(f"{API}signature/", {"image": "@@@"}, format="json", **h["sr_bm"]).status_code == 400
    api_client.put(f"{API}signature/", {"image": base64.b64encode(_png()).decode()}, format="json", **h["sr_bm"])
    # the signature is sealed at rest and private
    row = UserSignature.objects.get(user=org["bm"])
    assert bytes(row.image_enc)[:8] != _png()[:8]
    assert api_client.get(f"{API}signature/", **h["sr_emp"]).json()["has_signature"] is False
    assert api_client.delete(f"{API}signature/", **h["sr_bm"]).status_code == 204
    assert not UserSignature.objects.filter(user=org["bm"]).exists()


def test_signature_photo_on_paper_loses_its_background():
    """A phone photo of a signature (opaque JPEG, greyish paper with a shadow
    gradient) is stored as the ink alone on a transparent background, trimmed."""
    from PIL import Image, ImageDraw

    from apps.approvals.signing import clean_signature

    w, h = 1600, 1000
    img = Image.new("RGB", (w, h))
    px = img.load()
    for x in range(w):  # uneven light: 150 on the left (shadow) to 235 on the right
        shade = 150 + 85 * x // w
        for y in range(h):
            px[x, y] = (shade, shade, shade - 8)
    ImageDraw.Draw(img).line([(400, 600), (700, 380), (1200, 520)], fill=(40, 45, 90), width=10)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)

    out = Image.open(io.BytesIO(clean_signature(buf.getvalue())))
    assert out.mode == "RGBA"
    alpha = out.getchannel("A")
    # trimmed to the stroke (scaled ×0.6 by the 1200×600 thumbnail): ~480×170, not the whole photo
    assert out.width < 560 and out.height < 220
    # corners are paper → transparent; the middle of the stroke is ink → opaque
    assert max(alpha.getpixel((0, 0)), alpha.getpixel((out.width - 1, out.height - 1))) < 30
    assert alpha.getextrema()[1] == 255
    # the darkest shadowed paper did not turn into ink
    opaque = sum(1 for a in alpha.getdata() if a > 200)
    assert opaque < out.width * out.height * 0.4


def test_signature_blank_photo_rejected():
    from PIL import Image

    from apps.approvals.signing import clean_signature

    buf = io.BytesIO()
    Image.new("RGB", (800, 400), (230, 230, 225)).save(buf, "JPEG")
    with pytest.raises(Exception):
        clean_signature(buf.getvalue())
