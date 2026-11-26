"""Notifications forwarded to an outside e-mail (user decision 2026-11-26):
an account manager sets an employee's «إيميل التنبيهات» (e.g. the executive's
own Outlook); every in-app notification is then also e-mailed there — the
fixed title, who did it and a link to open it in the system, never content."""
import pytest

from apps.audit.models import AuditLog
from apps.notifications.models import NotificationPreference
from apps.notifications.services import notify

from .conftest import auth_headers, login

pytestmark = pytest.mark.django_db
USERS_URL = "/api/v1/users/"


@pytest.fixture(autouse=True)
def _brevo(settings):
    settings.EXTERNAL_MAIL_DOMAIN = "corp.test"
    settings.BREVO_API_KEY = "k"
    settings.BREVO_API_BASE = "https://brevo.test"
    settings.SITE_URL = "https://mail.corp.test"


@pytest.fixture
def mails(monkeypatch):
    sent = []

    class Resp:
        status_code = 201

    monkeypatch.setattr("requests.post", lambda url, **kw: sent.append(kw["json"]) or Resp())
    return sent


def _access(client, username):
    return login(client, username).json()["access"]


def test_admin_sets_the_notification_email(api_client, user_factory, role_factory):
    admin = user_factory("ne_admin")
    role_factory(admin, "sys_admin")
    target = user_factory("ne_exec")
    h = auth_headers(_access(api_client, "ne_admin"))

    r = api_client.patch(f"{USERS_URL}{target.id}/", {"notify_email": " W.Abukhader@Outside.example "}, format="json", **h)
    assert r.status_code == 200, r.content
    target.refresh_from_db()
    assert target.notify_email == "w.abukhader@outside.example"
    assert AuditLog.objects.filter(action="user_notify_email_set", metadata__enabled=True).exists()
    managed = api_client.get(f"{USERS_URL}managed/?q=ne_exec", **h).json()["results"]
    assert managed[0]["notify_email"] == "w.abukhader@outside.example"

    assert api_client.patch(f"{USERS_URL}{target.id}/", {"notify_email": "not-an-email"}, format="json", **h).status_code == 400
    # cleared = off
    assert api_client.patch(f"{USERS_URL}{target.id}/", {"notify_email": ""}, format="json", **h).status_code == 200
    target.refresh_from_db()
    assert target.notify_email == ""

    # a plain employee cannot set it, not even for themselves
    user_factory("ne_plain")
    hp = auth_headers(_access(api_client, "ne_plain"))
    assert api_client.patch(f"{USERS_URL}{target.id}/", {"notify_email": "x@y.example"}, format="json", **hp).status_code == 403


def test_notifications_are_emailed_without_content(django_capture_on_commit_callbacks, user_factory, mails):
    boss = user_factory("ne_boss")
    boss.notify_email = "boss@outside.example"
    boss.save()
    plain = user_factory("ne_other")
    sender = user_factory("ne_sender")
    sender.full_name = "أحمد حكيم"
    sender.save()

    with django_capture_on_commit_callbacks(execute=True):
        notify([boss.id, plain.id], "approval_requested", ref_type="approval_request",
               ref_id="11111111-2222-3333-4444-555555555555", actor=sender)

    assert len(mails) == 1  # only the one with a notification e-mail
    m = mails[0]
    assert m["to"] == [{"email": "boss@outside.example"}]
    assert m["subject"] == "لديك طلب اعتماد بانتظار قرارك — من أحمد حكيم"
    link = "https://mail.corp.test/approvals/11111111-2222-3333-4444-555555555555"
    assert link in m["textContent"] and link in m["htmlContent"]
    assert m["sender"]["email"] == "no-reply@corp.test"


def test_muted_kinds_and_archived_users_get_no_email(django_capture_on_commit_callbacks, user_factory, mails):
    boss = user_factory("ne_muted")
    boss.notify_email = "m@outside.example"
    boss.save()
    NotificationPreference.objects.create(user=boss, prefs={"muted_kinds": ["announcement"]})
    gone = user_factory("ne_gone")
    gone.notify_email = "g@outside.example"
    gone.is_active = False
    gone.save()

    with django_capture_on_commit_callbacks(execute=True):
        notify([boss.id, gone.id], "announcement", ref_type="announcement", ref_id=None)
    assert mails == []
    with django_capture_on_commit_callbacks(execute=True):
        notify([boss.id], "new_correspondence", ref_type="correspondence", ref_id=None)
    assert [m["to"][0]["email"] for m in mails] == ["m@outside.example"]


def test_nothing_is_sent_without_brevo(settings, django_capture_on_commit_callbacks, user_factory, mails):
    settings.BREVO_API_KEY = ""
    boss = user_factory("ne_nobrevo")
    boss.notify_email = "n@outside.example"
    boss.save()
    with django_capture_on_commit_callbacks(execute=True):
        notify([boss.id], "new_correspondence", ref_type="correspondence", ref_id=None)
    assert mails == []
