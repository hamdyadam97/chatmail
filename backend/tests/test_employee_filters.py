"""Employees list: filter by sign-in state, and by an announcement's
read/acknowledgement — only for someone who may follow that announcement."""
import io
import uuid

import openpyxl
import pytest

from .conftest import assign_role
from .correspondence_utils import make_employee
from .messaging_utils import auth

pytestmark = pytest.mark.django_db
MANAGED = "/api/v1/users/managed/"


@pytest.fixture
def org(api_client, user_factory, branch_a, branch_a2):
    pub = make_employee(user_factory, "f_pub", branch_a)
    assign_role(pub, "branch_manager", institute=branch_a.institute, branch=branch_a)
    e1 = make_employee(user_factory, "f_e1", branch_a)
    e2 = make_employee(user_factory, "f_e2", branch_a)
    admin = make_employee(user_factory, "f_admin", branch_a2)
    assign_role(admin, "sys_admin")
    h_pub, h_e1, h_admin = auth(api_client, "f_pub"), auth(api_client, "f_e1"), auth(api_client, "f_admin")
    ann = api_client.post("/api/v1/announcements/", {
        "target_type": "branch", "target_id": str(branch_a.id), "client_ref": str(uuid.uuid4()),
        "title": "تعميم سري", "body": "نص", "requires_ack": True,
    }, format="json", **h_pub).json()
    api_client.post(f"/api/v1/announcements/{ann['id']}/read/", **h_e1)
    api_client.post(f"/api/v1/announcements/{ann['id']}/ack/", **h_e1)
    return {"e1": e1, "e2": e2, "ann": ann, "h_admin": h_admin, "h_e1": h_e1, "branch_a2": branch_a2}


def names(resp):
    assert resp.status_code == 200, resp.content
    return {u["username"] for u in resp.json()["results"]}


def test_filter_by_announcement_acknowledgement(api_client, org):
    url = f"{MANAGED}?announcement={org['ann']['id']}"
    assert names(api_client.get(url, **org["h_admin"])) == {"f_e1", "f_e2"}
    assert names(api_client.get(f"{url}&ack=yes", **org["h_admin"])) == {"f_e1"}
    assert names(api_client.get(f"{url}&ack=no", **org["h_admin"])) == {"f_e2"}
    assert names(api_client.get(f"{url}&ack=unread", **org["h_admin"])) == {"f_e2"}
    rows = {u["username"]: u for u in api_client.get(url, **org["h_admin"]).json()["results"]}
    assert rows["f_e1"]["announcement_state"]["acknowledged_at"] and not rows["f_e2"]["announcement_state"]["acknowledged_at"]
    assert "تعميم سري" not in api_client.get(url, **org["h_admin"]).content.decode()
    assert api_client.get(f"{url}&ack=maybe", **org["h_admin"]).status_code == 400


def test_announcement_filter_needs_tracking_permission(api_client, user_factory, org):
    """Someone who manages staff but may not follow that announcement gets a
    refusal for the filter (not a silently empty list), and no other filter
    is affected."""
    from apps.authorization.models import Permission, Role, RolePermission

    role = Role.objects.create(code="t_staff_only", name_ar="إدارة حسابات فقط")
    RolePermission.objects.create(role=role, permission=Permission.objects.get(code="accounts.manage_users"))
    clerk = make_employee(user_factory, "f_clerk", org["branch_a2"])
    assign_role(clerk, "t_staff_only")
    h = auth(api_client, "f_clerk")
    assert api_client.get(MANAGED, **h).status_code == 200
    assert api_client.get(f"{MANAGED}?announcement={org['ann']['id']}", **h).status_code == 403
    assert api_client.get(f"{MANAGED}export/?announcement={org['ann']['id']}", **h).status_code == 403


def test_filter_by_sign_in_state(api_client, org):
    from django.utils import timezone

    org["e1"].last_login_at = timezone.now()
    org["e1"].must_change_password = False
    org["e1"].save()
    org["e2"].must_change_password = True
    org["e2"].save()
    assert "f_e2" in names(api_client.get(f"{MANAGED}?login=must_change", **org["h_admin"]))
    assert "f_e1" not in names(api_client.get(f"{MANAGED}?login=must_change", **org["h_admin"]))
    assert "f_e1" in names(api_client.get(f"{MANAGED}?login=done", **org["h_admin"]))
    assert "f_e1" not in names(api_client.get(f"{MANAGED}?login=never", **org["h_admin"]))
    assert api_client.get(f"{MANAGED}?login=x", **org["h_admin"]).status_code == 400


def test_export_has_the_announcement_columns(api_client, org):
    resp = api_client.get(f"{MANAGED}export/?announcement={org['ann']['id']}&ack=no", **org["h_admin"])
    assert resp.status_code == 200
    ws = openpyxl.load_workbook(io.BytesIO(resp.content)).active
    rows = list(ws.values)
    assert rows[0][-1].startswith("أقر بـ") and [r[1] for r in rows[1:]] == ["f_e2"] and rows[1][-1] == "لا"


def test_pdf_export_lists_name_workplace_state_and_announcement(api_client, org):
    from pypdf import PdfReader

    resp = api_client.get(f"{MANAGED}export/pdf/?announcement={org['ann']['id']}&ack=no", **org["h_admin"])
    assert resp.status_code == 200 and resp["Content-Type"] == "application/pdf"
    reader = PdfReader(io.BytesIO(resp.content))
    assert len(reader.pages) >= 1
    # one row (f_e2): no content of the announcement in the file
    assert b"\xd8\xaa\xd8\xb9\xd9\x85\xd9\x8a\xd9\x85 \xd8\xb3\xd8\xb1\xd9\x8a" not in resp.content
    from apps.audit.models import AuditLog

    assert AuditLog.objects.filter(action="employees_exported", metadata__format="pdf", metadata__count=1).exists()
    # same gate as the list: a staff-only manager without tracking is refused
    assert api_client.get(f"{MANAGED}export/pdf/", **org["h_e1"]).status_code == 403


def test_pdf_export_paginates_long_lists(api_client, user_factory, org):
    from pypdf import PdfReader

    for i in range(70):
        user_factory(f"f_many{i:02d}")
    resp = api_client.get(f"{MANAGED}export/pdf/", **org["h_admin"])
    assert resp.status_code == 200
    assert len(PdfReader(io.BytesIO(resp.content)).pages) >= 2
