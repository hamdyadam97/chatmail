"""External mail: addressing, inbound ingestion (sealed to devices, nothing
readable stored), Postfix exit codes, outbound via Brevo (mocked), and the
per-employee mailbox settings gate."""
import base64
import io
import json
import os
import sys
from email.message import EmailMessage

import pytest
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from django.core.management import call_command

from apps.accounts.models import TrustedDevice
from apps.audit.models import AuditLog
from apps.correspondence.models import StoredFile
from apps.correspondence.services import blob_storage
from apps.external_mail import crypto, services
from apps.external_mail.models import ExternalMailbox, ExternalMessage, ExternalMessageCopy
from apps.notifications.models import Notification

from .conftest import assign_role, auth_headers, login_and_get_access
from .correspondence_utils import _blob_root  # noqa: F401  (fixture)

pytestmark = pytest.mark.django_db
DOMAIN = "m3had-system.cloud"
CANARY = "CANARY-external-7d1e-secret-body"
API = "/api/v1/external-mail/"


@pytest.fixture(autouse=True)
def _mail_settings(settings):
    settings.EXTERNAL_MAIL_DOMAIN = DOMAIN
    settings.BREVO_API_KEY = "test-key"
    settings.BREVO_API_BASE = "https://brevo.test"
    settings.CLAMD_SOCKET = ""


def keyed_device(user, label="laptop"):
    priv = X25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    device = TrustedDevice.objects.create(
        user=user, device_label=label, platform="test", identity_sign_pub=os.urandom(32), kem_pub=pub, status="active"
    )
    return device, priv


def open_copy(message, device, priv) -> dict:
    copy = ExternalMessageCopy.objects.get(message=message, device=device)
    plain = crypto.unseal(priv, bytes(copy.ephemeral_pub), bytes(copy.iv), bytes(copy.ciphertext),
                          crypto.copy_aad(message.id, device.id))
    return json.loads(plain)


def mail(to="ahmed@" + DOMAIN, subject="عرض أسعار", body=CANARY, html=None, attachment=None, **headers) -> bytes:
    m = EmailMessage()
    m["From"] = "Supplier <sales@example.com>"
    m["To"] = to
    m["Subject"] = subject
    m["Message-ID"] = headers.get("message_id", "<abc123@example.com>")
    if "in_reply_to" in headers:
        m["In-Reply-To"] = headers["in_reply_to"]
    if html is not None:
        m.set_content(html, subtype="html")
    else:
        m.set_content(body)
    if attachment:
        m.add_attachment(attachment, maintype="application", subtype="pdf", filename="offer.pdf")
    return bytes(m)


@pytest.fixture
def ahmed(user_factory):
    user = user_factory("ahmed")
    device, priv = keyed_device(user)
    return {"user": user, "device": device, "priv": priv}


# --- addresses ------------------------------------------------------------------------------

def test_address_defaults_to_username_and_alias_overrides(ahmed, user_factory):
    assert services.address_for(ahmed["user"]) == f"ahmed@{DOMAIN}"
    assert services.resolve(f"Ahmed@{DOMAIN}") == ahmed["user"]
    assert services.resolve(f"ahmed+orders@{DOMAIN}") == ahmed["user"]  # plus-addressing
    services.set_local_part(ahmed["user"], "a.alotaibi")
    assert services.resolve(f"a.alotaibi@{DOMAIN}") == ahmed["user"]
    with pytest.raises(services.UnknownRecipient):
        services.resolve(f"ahmed@{DOMAIN}")  # the login name is no longer public
    with pytest.raises(services.UnknownRecipient):
        services.resolve("ahmed@other.example")
    other = user_factory("mohamed")
    with pytest.raises(Exception):
        services.set_local_part(other, "a.alotaibi")  # taken


def test_disabled_or_inactive_mailbox_is_unknown(ahmed):
    ExternalMailbox.objects.create(user=ahmed["user"], receiving_enabled=False)
    with pytest.raises(services.UnknownRecipient):
        services.resolve(f"ahmed@{DOMAIN}")
    ExternalMailbox.objects.filter(user=ahmed["user"]).update(receiving_enabled=True)
    ahmed["user"].is_active = False
    ahmed["user"].save()
    with pytest.raises(services.UnknownRecipient):
        services.resolve(f"ahmed@{DOMAIN}")


# --- inbound ---------------------------------------------------------------------------------

def test_ingest_seals_to_each_device_and_stores_nothing_readable(ahmed, settings):
    phone, phone_priv = keyed_device(ahmed["user"], "phone")
    pdf = b"%PDF-1.7 " + CANARY.encode() + os.urandom(64)
    m = services.ingest(mail(attachment=pdf), recipient=f"ahmed@{DOMAIN}")
    assert m.direction == "in" and m.mail_from == "sales@example.com" and m.attachment_count == 1

    for device, priv in ((ahmed["device"], ahmed["priv"]), (phone, phone_priv)):
        content = open_copy(m, device, priv)
        assert content["subject"] == "عرض أسعار" and CANARY in content["body"]
        assert content["from"]["address"] == "sales@example.com"
    att = {a["name"]: a for a in content["attachments"]}
    assert set(att) == {"offer.pdf", "original.eml"}
    stored = StoredFile.objects.get(id=att["offer.pdf"]["id"])
    with blob_storage().open(stored.storage_key, "rb") as fh:
        blob = fh.read()
    key = base64.b64decode(att["offer.pdf"]["key"])
    assert AESGCM(key).decrypt(blob[:12], blob[12:], crypto.ATTACHMENT_AAD) == pdf

    # nothing readable at rest: rows, sealed copies, blobs
    rows = repr(list(ExternalMessage.objects.values())) + repr(list(ExternalMessageCopy.objects.values_list("ciphertext", flat=True)))
    assert CANARY not in rows and "عرض أسعار" not in rows
    root = settings.ENCRYPTED_BLOB_ROOT
    for dirpath, _, files in os.walk(root):
        for f in files:
            assert CANARY.encode() not in open(os.path.join(dirpath, f), "rb").read()
    n = Notification.objects.get(user=ahmed["user"], kind="external_mail")
    assert "عرض" not in n.title_generic
    audit = AuditLog.objects.get(action="external_mail_received")
    assert CANARY not in json.dumps(audit.metadata, ensure_ascii=False) and "عرض" not in json.dumps(audit.metadata, ensure_ascii=False)


def test_html_only_mail_becomes_plain_text(ahmed):
    html = "<html><head><style>p{}</style><script>alert(1)</script></head><body><p>مرحبا</p><a href='https://x.example/a'>link</a></body></html>"
    m = services.ingest(mail(html=html), recipient=f"ahmed@{DOMAIN}")
    content = open_copy(m, ahmed["device"], ahmed["priv"])
    assert "مرحبا" in content["body"] and "https://x.example/a" in content["body"]
    assert "<script>" not in content["body"] and "alert(1)" not in content["body"] and content["html_converted"]


def test_unknown_no_device_and_too_large(ahmed, user_factory, settings):
    with pytest.raises(services.UnknownRecipient):
        services.ingest(mail(), recipient=f"nobody@{DOMAIN}")
    user_factory("sara")
    with pytest.raises(services.TemporaryFailure):  # can't seal for nobody yet -> Postfix retries
        services.ingest(mail(), recipient=f"sara@{DOMAIN}")
    settings.EXTERNAL_MAIL_MAX_BYTES = 100
    with pytest.raises(Exception):
        services.ingest(mail(), recipient=f"ahmed@{DOMAIN}")


def test_authentication_result(ahmed):
    unsigned = services.ingest(mail(), recipient=f"ahmed@{DOMAIN}")
    assert unsigned.auth_result == "none"
    spf = b"Received-SPF: Pass (mailfrom) identity=mailfrom\r\n" + mail(message_id="<x2@example.com>")
    assert services.ingest(spf, recipient=f"ahmed@{DOMAIN}").auth_result == "pass"


def test_postfix_command_exit_codes(ahmed, monkeypatch):
    def run(raw, recipient):
        monkeypatch.setattr(sys, "stdin", type("S", (), {"buffer": io.BytesIO(raw)})())
        with pytest.raises(SystemExit) as exc:
            call_command("ingest_external_mail", "--recipient", recipient)
        return exc.value.code

    assert run(mail(), f"ahmed@{DOMAIN}") == 0
    assert run(mail(), f"ghost@{DOMAIN}") == 67
    ahmed["device"].status = "revoked"
    ahmed["device"].save()
    assert run(mail(), f"ahmed@{DOMAIN}") == 75


def test_recipient_map(ahmed, user_factory, tmp_path):
    user_factory("sara")
    off = user_factory("old")
    ExternalMailbox.objects.create(user=off, receiving_enabled=False)
    out = tmp_path / "recipients"
    call_command("export_mail_recipients", "--output", str(out))
    lines = out.read_text().split()
    assert f"ahmed@{DOMAIN}" in lines and f"sara@{DOMAIN}" in lines and f"old@{DOMAIN}" not in lines


# --- outbound ----------------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status=201):
        self.status_code = status


def test_send_requires_permission_then_goes_out_as_the_employee(ahmed, monkeypatch, api_client):
    calls = []
    monkeypatch.setattr("requests.post", lambda url, **kw: calls.append((url, kw)) or FakeResponse())
    login_and_get_access(api_client, "ahmed")
    body = {"to": ["client@gmail.com"], "subject": "رد", "body": CANARY}
    assert api_client.post(f"{API}send/", body, format="json").status_code == 403
    ExternalMailbox.objects.create(user=ahmed["user"], sending_enabled=True, local_part="a.alotaibi")

    inbound = services.ingest(mail(to=f"a.alotaibi@{DOMAIN}"), recipient=f"a.alotaibi@{DOMAIN}")
    r = api_client.post(f"{API}send/", {**body, "reply_to_id": str(inbound.id)}, format="json")
    assert r.status_code == 201, r.content
    url, kw = calls[0]
    assert url == "https://brevo.test/v3/smtp/email" and kw["headers"]["api-key"] == "test-key"
    payload = kw["json"]
    assert payload["sender"]["email"] == f"a.alotaibi@{DOMAIN}" and payload["replyTo"]["email"] == f"a.alotaibi@{DOMAIN}"
    assert payload["headers"]["In-Reply-To"] == "<abc123@example.com>"

    sent = ExternalMessage.objects.get(id=r.json()["id"])
    assert sent.direction == "out" and sent.in_reply_to_id == inbound.id
    assert CANARY in open_copy(sent, ahmed["device"], ahmed["priv"])["body"]
    assert CANARY not in repr(list(ExternalMessage.objects.values()))


def test_send_rejects_internal_and_failures_leave_no_row(ahmed, monkeypatch, api_client):
    ExternalMailbox.objects.create(user=ahmed["user"], sending_enabled=True)
    login_and_get_access(api_client, "ahmed")
    r = api_client.post(f"{API}send/", {"to": [f"x@{DOMAIN}"], "subject": "s", "body": "b"}, format="json")
    assert r.status_code == 400  # colleagues: use internal E2EE correspondence
    monkeypatch.setattr("requests.post", lambda url, **kw: FakeResponse(400))
    r = api_client.post(f"{API}send/", {"to": ["a@gmail.com"], "subject": "s", "body": "b"}, format="json")
    assert r.status_code == 502 and not ExternalMessage.objects.filter(direction="out").exists()


# --- API -----------------------------------------------------------------------------------------

def test_messages_are_private_and_sealed_per_device(ahmed, user_factory, api_client):
    m = services.ingest(mail(), recipient=f"ahmed@{DOMAIN}")
    user_factory("mallory")
    login_and_get_access(api_client, "mallory")
    assert api_client.get(f"{API}messages/").json()["count"] == 0
    assert api_client.get(f"{API}messages/{m.id}/").status_code == 403
    login_and_get_access(api_client, "ahmed")
    detail = api_client.get(f"{API}messages/{m.id}/?device_id={ahmed['device'].id}").json()
    assert detail["sealed"]["ciphertext"] and "subject" not in detail
    me = api_client.get(f"{API}me/").json()
    assert me["address"] == f"ahmed@{DOMAIN}" and me["unread"] == 1 and me["sending_enabled"] is False
    api_client.post(f"{API}messages/{m.id}/read/")
    assert api_client.get(f"{API}me/").json()["unread"] == 0


def test_mailbox_settings_need_manage_users(ahmed, user_factory, api_client, branch_a):
    admin = user_factory("acct_admin", membership_unit=branch_a)
    assign_role(admin, "sys_admin")
    plain = user_factory("plain_user", membership_unit=branch_a)
    url = f"{API}mailboxes/{ahmed['user'].id}/"
    login_and_get_access(api_client, "plain_user")
    assert api_client.patch(url, {"sending_enabled": True}, format="json").status_code == 403
    login_and_get_access(api_client, "acct_admin")
    r = api_client.patch(url, {"sending_enabled": True, "local_part": "A.Alotaibi"}, format="json")
    assert r.status_code == 200 and r.json()["address"] == f"a.alotaibi@{DOMAIN}" and r.json()["sending_enabled"]
    assert api_client.patch(url, {"local_part": "bad name!"}, format="json").status_code == 400
    assert AuditLog.objects.filter(action="external_mailbox_updated", target_id=ahmed["user"].id).exists()
    del plain
