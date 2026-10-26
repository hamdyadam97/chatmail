"""External mail: addresses, inbound ingestion (from the local Postfix) and
outbound sending (through Brevo). See models.py for the storage contract:
content is sealed to the owner's devices immediately; nothing readable is
written to the database, the blob store or the logs.
"""
import json
import logging
import re
import socket
import struct
from datetime import timedelta
from email import message_from_bytes, policy
from email.utils import formataddr, getaddresses, make_msgid, parseaddr
from html.parser import HTMLParser

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError

from apps.accounts.models import TrustedDevice, User
from apps.audit.services import log
from apps.correspondence.services import store_blob
from apps.notifications.services import notify

from . import crypto
from .models import ExternalAttachment, ExternalMailbox, ExternalMessage, ExternalMessageCopy

logger = logging.getLogger(__name__)

LOCAL_PART_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")
EMAIL_RE = re.compile(r"^[^@\s<>\"']{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$")
MAX_BODY_CHARS = 200_000
MAX_RECIPIENTS = 20


class UnknownRecipient(Exception):
    """No (enabled) mailbox for this address — Postfix bounces (EX_NOUSER)."""


class TemporaryFailure(Exception):
    """Retry later (EX_TEMPFAIL): e.g. the recipient has no device to seal to yet."""


class SendFailed(APIException):
    status_code = 502
    default_detail = "تعذر إرسال البريد الخارجي الآن، حاول لاحقًا."


def domain() -> str:
    return (settings.EXTERNAL_MAIL_DOMAIN or "").strip().lower()


def receiving_configured() -> bool:
    return bool(domain())


def sending_configured() -> bool:
    return bool(domain() and settings.BREVO_API_KEY)


# --- addresses -----------------------------------------------------------------------------

def mailbox_for(user) -> ExternalMailbox:
    return ExternalMailbox.objects.filter(user=user).first() or ExternalMailbox(user=user)


def local_part_for(user) -> str | None:
    mb = mailbox_for(user)
    lp = (mb.local_part or user.username or "").lower()
    return lp if LOCAL_PART_RE.match(lp) else None


def address_for(user) -> str | None:
    lp = local_part_for(user)
    return f"{lp}@{domain()}" if lp and domain() else None


def resolve(address: str):
    """Envelope recipient -> active user with receiving enabled, else UnknownRecipient."""
    address = (address or "").strip().lower()
    if "@" not in address:
        raise UnknownRecipient(address)
    lp, _, dom = address.rpartition("@")
    lp = lp.split("+", 1)[0]  # plus-addressing: ahmed+anything@ -> ahmed
    if dom != domain() or not LOCAL_PART_RE.match(lp):
        raise UnknownRecipient(address)
    mb = ExternalMailbox.objects.filter(local_part=lp).select_related("user").first()
    user = mb.user if mb else None
    if user is None:
        user = User.objects.filter(username__iexact=lp).first()
        if user is not None:
            own = ExternalMailbox.objects.filter(user=user).first()
            if own is not None and own.local_part and own.local_part != lp:
                user = None  # renamed: the username is no longer an address
    if user is None or not user.is_active or not mailbox_for(user).receiving_enabled:
        raise UnknownRecipient(address)
    return user


def set_local_part(user, local_part: str | None) -> ExternalMailbox:
    mb = mailbox_for(user)
    if local_part:
        local_part = local_part.strip().lower()
        if not LOCAL_PART_RE.match(local_part):
            raise ValidationError({"local_part": "اسم بريد غير صالح (حروف إنجليزية صغيرة وأرقام و . _ - فقط)."})
        taken = ExternalMailbox.objects.filter(local_part=local_part).exclude(user=user).exists() or (
            User.objects.filter(username__iexact=local_part).exclude(pk=user.pk)
            .exclude(external_mailbox__local_part__isnull=False).exists()
        )
        if taken:
            raise ValidationError({"local_part": "اسم البريد مستخدم لموظف آخر."})
    mb.local_part = local_part or None
    mb.save()
    return mb


def recipients_map_lines() -> list[str]:
    """For Postfix relay_recipient_maps: every address that may receive."""
    lines = []
    users = User.objects.filter(is_active=True).select_related("external_mailbox")
    for user in users:
        mb = getattr(user, "external_mailbox", None)
        if mb is not None and not mb.receiving_enabled:
            continue
        address = address_for(user)
        if address:
            lines.append(f"{address} OK")
    return sorted(lines)


# --- sealing --------------------------------------------------------------------------------

def _owner_devices(user) -> list[TrustedDevice]:
    return list(
        TrustedDevice.objects.filter(
            user=user, status="active", identity_sign_pub__isnull=False, kem_pub__isnull=False
        )
    )


def _seal_for_devices(message: ExternalMessage, devices, content: dict) -> None:
    plaintext = json.dumps(content, ensure_ascii=False).encode()
    ExternalMessageCopy.objects.bulk_create(
        [
            ExternalMessageCopy(
                message=message,
                device=d,
                **dict(zip(("ephemeral_pub", "iv", "ciphertext"),
                           crypto.seal(bytes(d.kem_pub), plaintext, crypto.copy_aad(message.id, d.id)))),
            )
            for d in devices
        ]
    )


def _store_attachments(owner, message: ExternalMessage, files: list[dict]) -> list[dict]:
    keys = []
    for f in files:
        blob, key, sha = crypto.encrypt_attachment(f["data"])
        stored = store_blob(owner, blob)
        ExternalAttachment.objects.create(message=message, stored_file=stored)
        keys.append({"id": str(stored.id), "name": f["name"][:255], "mime": f["mime"][:255],
                     "size": len(f["data"]), "key": key, "sha256": sha})
    return keys


# --- inbound --------------------------------------------------------------------------------

class _TextExtractor(HTMLParser):
    """HTML -> plain text. Mail HTML is never rendered (XSS/tracking pixels)."""

    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")
        elif tag == "a":
            href = dict(attrs).get("href") or ""
            if href.startswith(("http://", "https://", "mailto:")):
                self.parts.append(f" [{href}] ")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head") and self.skip:
            self.skip -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    text = "".join(parser.parts)
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", text)).strip()


def _addresses(values) -> list[dict]:
    return [{"name": n, "address": a.lower()} for n, a in getaddresses(values or []) if a]


def _authenticate(raw: bytes, msg, from_domain: str) -> str:
    """'pass' if a valid DKIM signature aligns with the From domain or our
    Postfix's SPF check (topmost Received-SPF) passed; else 'fail' / 'none'."""
    try:
        import dkim

        signatures = msg.get_all("DKIM-Signature") or []
        if signatures and dkim.verify(raw):
            for sig in signatures:
                d = re.search(r"\bd=([^;\s]+)", str(sig))
                if d and (from_domain == d.group(1).lower() or from_domain.endswith("." + d.group(1).lower())):
                    return "pass"
        spf = (msg.get_all("Received-SPF") or [""])[0].strip().lower()
        if spf.startswith("pass"):
            return "pass"
        return "fail" if signatures or spf.startswith(("fail", "softfail")) else "none"
    except Exception:  # DNS errors etc. must never block delivery
        return "none"


def _virus_scan(data: bytes) -> str:
    """'clean' | 'infected' | 'unscanned' via clamd INSTREAM, if configured."""
    path = settings.CLAMD_SOCKET
    if not path:
        return "unscanned"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(30)
            s.connect(path)
            s.sendall(b"zINSTREAM\0")
            for i in range(0, len(data), 65536):
                chunk = data[i:i + 65536]
                s.sendall(struct.pack("!L", len(chunk)) + chunk)
            s.sendall(struct.pack("!L", 0))
            reply = s.recv(4096).decode(errors="replace")
        return "infected" if "FOUND" in reply else "clean"
    except OSError:
        return "unscanned"


def parse(raw: bytes) -> dict:
    msg = message_from_bytes(raw, policy=policy.default)
    from_name, from_addr = parseaddr(str(msg.get("From", "")))
    body_part = msg.get_body(preferencelist=("plain", "html"))
    body, converted = "", False
    if body_part is not None:
        try:
            text = body_part.get_content()
        except (LookupError, UnicodeError):
            text = body_part.get_payload(decode=True).decode("utf-8", errors="replace")
        if body_part.get_content_type() == "text/html":
            text, converted = html_to_text(text), True
        body = text[:MAX_BODY_CHARS]
    files = []
    for part in msg.iter_attachments():
        data = part.get_payload(decode=True) or b""
        if data:
            files.append({"name": part.get_filename() or "attachment", "mime": part.get_content_type(), "data": data})
    return {
        "msg": msg,
        "from": {"name": from_name, "address": from_addr.lower()},
        "to": _addresses(msg.get_all("To")),
        "cc": _addresses(msg.get_all("Cc")),
        "subject": str(msg.get("Subject", ""))[:998],
        "date": str(msg.get("Date", "")),
        "message_id": str(msg.get("Message-ID", "")).strip(),
        "in_reply_to": str(msg.get("In-Reply-To", "")).strip(),
        "body": body,
        "html_converted": converted,
        "files": files,
    }


def ingest(raw: bytes, *, recipient: str, sender: str = "") -> ExternalMessage:
    """Deliver one inbound message to its recipient (called by Postfix's pipe)."""
    if len(raw) > settings.EXTERNAL_MAIL_MAX_BYTES:
        raise ValidationError("message too large")
    user = resolve(recipient)
    devices = _owner_devices(user)
    if not devices:
        raise TemporaryFailure("recipient has no active device yet")
    p = parse(raw)
    from_domain = p["from"]["address"].rpartition("@")[2]
    auth = _authenticate(raw, p["msg"], from_domain)
    scanned, dropped = [], []
    for f in p["files"]:
        verdict = _virus_scan(f["data"])
        (dropped if verdict == "infected" else scanned).append({**f, "scan": verdict})
    # The original message, as an encrypted attachment (full fidelity for records).
    scanned.append({"name": "original.eml", "mime": "message/rfc822", "data": raw, "scan": "n/a"})

    parent = None
    if p["in_reply_to"]:
        parent = ExternalMessage.objects.filter(owner=user, message_id=p["in_reply_to"]).first()

    with transaction.atomic():
        message = ExternalMessage.objects.create(
            owner=user,
            direction="in",
            mail_from=p["from"]["address"][:320] or (sender or "")[:320],
            recipients=[a["address"] for a in p["to"] + p["cc"]][:50],
            message_id=p["message_id"][:998],
            in_reply_to=parent,
            auth_result=auth,
            size=len(raw),
            attachment_count=len(scanned) - 1,
        )
        attachments = _store_attachments(user, message, scanned)
        content = {
            "v": 1,
            "kind": "external",
            "direction": "in",
            "from": p["from"],
            "to": p["to"],
            "cc": p["cc"],
            "subject": p["subject"],
            "date": p["date"],
            "body": p["body"],
            "html_converted": p["html_converted"],
            "auth": auth,
            "attachments": attachments,
            "removed_infected": [f["name"] for f in dropped],
            "virus_scan": "on" if settings.CLAMD_SOCKET else "off",
        }
        _seal_for_devices(message, devices, content)
        notify([user.id], "external_mail", ref_type="external_message", ref_id=message.id)
    log(actor=None, action="external_mail_received", target_type="external_message", target_id=message.id,
        metadata={"size": len(raw), "attachments": len(scanned) - 1, "auth": auth, "infected": len(dropped)})
    return message


# --- outbound -------------------------------------------------------------------------------

def _clean_recipients(values, field) -> list[str]:
    out = []
    for v in values or []:
        v = str(v).strip()
        if not EMAIL_RE.match(v):
            raise ValidationError({field: f"عنوان غير صالح: {v}"})
        if v.lower().endswith("@" + domain()):
            raise ValidationError({field: "للزملاء داخل النظام استخدم المراسلات الداخلية المشفّرة."})
        out.append(v)
    return out


def send(user, *, to, cc=(), subject: str, body: str, attachments=(), reply_to_id=None) -> ExternalMessage:
    import requests

    if not sending_configured():
        raise ValidationError({"detail": "الإرسال الخارجي غير مُعد على هذا الخادم."})
    if not mailbox_for(user).sending_enabled:
        raise PermissionDenied("الإرسال للخارج غير مفعّل لحسابك — اطلبه من مسؤول النظام.")
    address = address_for(user)
    if not address:
        raise ValidationError({"detail": "لا عنوان خارجي صالح لحسابك."})
    to_list, cc_list = _clean_recipients(to, "to"), _clean_recipients(cc, "cc")
    if not to_list or len(to_list) + len(cc_list) > MAX_RECIPIENTS:
        raise ValidationError({"to": f"من مستلم واحد إلى {MAX_RECIPIENTS} مستلمًا."})
    subject, body = (subject or "").strip()[:998], (body or "")[:MAX_BODY_CHARS]
    if not subject:
        raise ValidationError({"subject": "العنوان مطلوب."})
    since = timezone.now() - timedelta(days=1)
    if ExternalMessage.objects.filter(owner=user, direction="out", created_at__gte=since).count() >= settings.EXTERNAL_MAIL_DAILY_LIMIT:
        raise PermissionDenied("بلغت الحد اليومي للإرسال الخارجي.")
    files = list(attachments)
    if sum(len(f["data"]) for f in files) > settings.EXTERNAL_MAIL_MAX_SEND_BYTES:
        raise ValidationError({"attachments": "المرفقات أكبر من المسموح."})
    devices = _owner_devices(user)

    parent = None
    headers = {}
    if reply_to_id:
        parent = ExternalMessage.objects.filter(owner=user, id=reply_to_id).first()
        if parent is not None and parent.message_id:
            headers = {"In-Reply-To": parent.message_id, "References": parent.message_id}
    message_id = make_msgid(domain=domain())
    payload = {
        "sender": {"name": user.full_name or user.username, "email": address},
        "replyTo": {"email": address, "name": user.full_name or user.username},
        "to": [{"email": a} for a in to_list],
        "subject": subject,
        "textContent": body or " ",
        "headers": {"Message-ID": message_id, **headers},
    }
    if cc_list:
        payload["cc"] = [{"email": a} for a in cc_list]
    if files:
        import base64

        payload["attachment"] = [{"name": f["name"], "content": base64.b64encode(f["data"]).decode()} for f in files]
    try:
        resp = requests.post(
            f"{settings.BREVO_API_BASE.rstrip('/')}/v3/smtp/email",
            json=payload,
            headers={"api-key": settings.BREVO_API_KEY, "accept": "application/json"},
            timeout=30,
        )
    except requests.RequestException:
        logger.warning("brevo request failed")
        raise SendFailed()
    if resp.status_code >= 300:
        logger.warning("brevo rejected the message (status=%s)", resp.status_code)
        raise SendFailed()

    with transaction.atomic():
        message = ExternalMessage.objects.create(
            owner=user, direction="out", mail_from=address, recipients=to_list + cc_list,
            message_id=message_id, in_reply_to=parent, auth_result="pass",
            size=len(body.encode()) + sum(len(f["data"]) for f in files), attachment_count=len(files),
            read_at=timezone.now(),
        )
        attachments = _store_attachments(user, message, files)
        _seal_for_devices(message, devices, {
            "v": 1, "kind": "external", "direction": "out",
            "from": {"name": user.full_name or user.username, "address": address},
            "to": [{"name": "", "address": a} for a in to_list],
            "cc": [{"name": "", "address": a} for a in cc_list],
            "subject": subject, "date": timezone.now().isoformat(), "body": body,
            "html_converted": False, "auth": "pass", "attachments": attachments,
            "removed_infected": [], "virus_scan": "off",
        })
    log(actor=user, action="external_mail_sent", target_type="external_message", target_id=message.id,
        metadata={"recipients": len(to_list) + len(cc_list), "attachments": len(files)})
    return message


def summary(m: ExternalMessage) -> dict:
    return {
        "id": str(m.id),
        "direction": m.direction,
        "from": m.mail_from,
        "recipients": m.recipients,
        "auth": m.auth_result,
        "size": m.size,
        "attachment_count": m.attachment_count,
        "in_reply_to_id": str(m.in_reply_to_id) if m.in_reply_to_id else None,
        "created_at": m.created_at.isoformat(),
        "read_at": m.read_at.isoformat() if m.read_at else None,
    }


def own_message(user, message_id) -> ExternalMessage:
    m = ExternalMessage.objects.filter(owner=user, id=message_id).first()
    if m is None:
        raise PermissionDenied("الرسالة غير موجودة.")
    return m


def copy_for_device(user, message, device_id) -> ExternalMessageCopy | None:
    return ExternalMessageCopy.objects.filter(message=message, device__user=user, device_id=device_id).first()


def search_q(q: str):
    return Q(mail_from__icontains=q) | Q(recipients__icontains=q)
