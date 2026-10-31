"""New-browser login needs an administrator's code (user decision): known
browsers log in straight away, codes go to central account admins in-app and
by e-mail, are single-use, expire, lock after 5 tries, and can be rejected."""
import pytest
from django.core.management import call_command
from rest_framework.test import APIClient

from apps.accounts import login_approval
from apps.accounts.models import LoginApproval, UserSession
from apps.audit.models import AuditLog
from apps.notifications.models import Notification

from .conftest import DEFAULT_PASSWORD, assign_role, auth_headers, login

pytestmark = pytest.mark.django_db
AUTH = "/api/v1/auth/"


@pytest.fixture(autouse=True)
def _on(settings):
    settings.LOGIN_NEW_DEVICE_APPROVAL = True
    settings.EXTERNAL_MAIL_DOMAIN = "corp.test"
    settings.BREVO_API_KEY = "k"
    settings.BREVO_API_BASE = "https://brevo.test"


@pytest.fixture
def people(user_factory):
    admin = user_factory("la_admin")
    admin.optional_email = "it@corp.test"
    admin.save()
    assign_role(admin, "sys_admin")  # central accounts.manage_users
    return {"admin": admin, "emp": user_factory("la_emp")}


@pytest.fixture
def mails(monkeypatch):
    sent = []

    class Resp:
        status_code = 201

    monkeypatch.setattr("requests.post", lambda url, **kw: sent.append(kw["json"]) or Resp())
    return sent


def _code_for(username):
    a = LoginApproval.objects.filter(user__username=username, status="pending").latest("created_at")
    return login_approval.code_of(a)


def _approve_admin_browser(client):
    """The admin's own first login also needs a code (here: from the server console)."""
    r = login(client, "la_admin")
    assert r.json()["approval_required"]
    r = client.post(f"{AUTH}login/code/", {"approval_token": r.json()["approval_token"], "code": _code_for("la_admin")},
                    format="json")
    assert r.status_code == 200, r.content
    return auth_headers(r.json()["access"])


def test_new_browser_needs_the_admin_code_then_is_known(people, mails, django_capture_on_commit_callbacks):
    browser = APIClient()
    with django_capture_on_commit_callbacks(execute=True):
        r = login(browser, "la_emp")
    body = r.json()
    assert r.status_code == 200 and body["approval_required"] and "access" not in body
    assert not UserSession.objects.filter(user=people["emp"]).exists()
    code = _code_for("la_emp")
    # admin told in-app (no code in the notification) and by e-mail (with the code)
    n = Notification.objects.get(user=people["admin"], kind="login_approval")
    assert code not in n.title_generic
    assert mails and mails[0]["to"] == [{"email": "it@corp.test"}] and code in mails[0]["textContent"]
    assert all(code not in repr(a.metadata) for a in AuditLog.objects.all())

    ok = browser.post(f"{AUTH}login/code/", {"approval_token": body["approval_token"], "code": code}, format="json")
    assert ok.status_code == 200 and ok.json()["access"]
    assert login_approval.DEVICE_COOKIE in ok.cookies
    # same browser later: straight in; a different browser: a new code
    assert "access" in login(browser, "la_emp").json()
    assert login(APIClient(), "la_emp").json()["approval_required"]


def test_code_is_single_use_and_locks_after_five_wrong_tries(people):
    r = login(APIClient(), "la_emp").json()
    url = f"{AUTH}login/code/"
    for _ in range(5):
        assert APIClient().post(url, {"approval_token": r["approval_token"], "code": "000000x"},
                                format="json").status_code == 401
    right = APIClient().post(url, {"approval_token": r["approval_token"], "code": _code_for_any(r)}, format="json")
    assert right.status_code == 401  # locked
    r2 = login(APIClient(), "la_emp").json()
    code = _code_for("la_emp")
    assert APIClient().post(url, {"approval_token": r2["approval_token"], "code": code}, format="json").status_code == 200
    assert APIClient().post(url, {"approval_token": r2["approval_token"], "code": code}, format="json").status_code == 401


def _code_for_any(resp):
    from apps.accounts.tokens import decode_login_approval_token

    return login_approval.code_of(LoginApproval.objects.get(id=decode_login_approval_token(resp["approval_token"])["aid"]))


def test_admins_list_and_reject_others_cannot(people):
    h_admin = _approve_admin_browser(APIClient())
    r = login(APIClient(), "la_emp").json()
    rows = APIClient().get(f"{AUTH}login-approvals/", **h_admin).json()
    assert [x["user"]["username"] for x in rows] == ["la_emp"] and len(rows[0]["code"]) == 6
    # the employee (once signed in on an approved browser) cannot see codes
    emp_browser = APIClient()
    first = login(emp_browser, "la_emp").json()
    emp_browser.post(f"{AUTH}login/code/", {"approval_token": first["approval_token"], "code": _code_for_any(first)},
                     format="json")
    h_emp = auth_headers(login(emp_browser, "la_emp").json()["access"])
    assert APIClient().get(f"{AUTH}login-approvals/", **h_emp).status_code == 403
    assert APIClient().post(f"{AUTH}login-approvals/{rows[0]['id']}/reject/", **h_admin).status_code == 204
    assert APIClient().post(f"{AUTH}login/code/", {"approval_token": r["approval_token"], "code": rows[0]["code"]},
                            format="json").status_code == 401


def test_server_console_shows_pending_codes(people, capsys):
    login(APIClient(), "la_admin")
    call_command("login_codes", "--user", "la_admin")
    assert _code_for("la_admin") in capsys.readouterr().out


def test_signed_in_browser_becomes_known_through_refresh(people, settings):
    settings.LOGIN_NEW_DEVICE_APPROVAL = False
    browser = APIClient()
    login(browser, "la_emp")  # before the feature: the login marks the browser known
    browser.cookies.pop(login_approval.DEVICE_COOKIE, None)  # e.g. signed in before this release
    from apps.accounts.models import TrustedDevice

    TrustedDevice.objects.filter(user=people["emp"]).update(browser_token_hash=None)
    settings.LOGIN_NEW_DEVICE_APPROVAL = True
    r = browser.post(f"{AUTH}refresh/")
    assert r.status_code == 200 and login_approval.DEVICE_COOKIE in r.cookies
    assert "access" in login(browser, "la_emp", DEFAULT_PASSWORD).json()
