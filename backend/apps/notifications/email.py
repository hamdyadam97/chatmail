"""System e-mail through Brevo (the same account as external mail). Silent
no-op when Brevo or the mail domain is not configured; failures are logged
without the message text."""
import html as html_lib
import logging

from django.conf import settings
from django.db import transaction

logger = logging.getLogger(__name__)


def configured() -> bool:
    return bool(settings.BREVO_API_KEY and settings.EXTERNAL_MAIL_DOMAIN)


def send_email(to: list[str], subject: str, text: str, html: str | None = None) -> None:
    """Queued after the surrounding transaction commits."""
    to = [a for a in dict.fromkeys(to) if a]
    if not to or not configured():
        return

    def _send():
        import requests

        payload = {
            "sender": {"name": "نظام المراسلات", "email": f"no-reply@{settings.EXTERNAL_MAIL_DOMAIN}"},
            "to": [{"email": a} for a in to],
            "subject": subject,
            "textContent": text,
        }
        if html:
            payload["htmlContent"] = html
        try:
            resp = requests.post(
                f"{settings.BREVO_API_BASE.rstrip('/')}/v3/smtp/email",
                json=payload,
                headers={"api-key": settings.BREVO_API_KEY, "accept": "application/json"},
                timeout=20,
            )
            if resp.status_code >= 300:
                logger.warning("system e-mail rejected by Brevo (status=%s)", resp.status_code)
        except requests.RequestException:
            logger.warning("system e-mail could not reach Brevo")

    transaction.on_commit(_send)


def site_url() -> str:
    if settings.SITE_URL:
        return settings.SITE_URL
    hosts = [h for h in settings.ALLOWED_HOSTS if h not in ("*", "localhost", "127.0.0.1") and not h.startswith(".")]
    return f"https://{hosts[0]}" if hosts else ""


def notification_email(title: str, actor_name: str, path: str) -> tuple[str, str, str]:
    """(subject, text, html) of a notification forwarded to an outside
    address: the fixed title, who did it, and a link — never content (SEC-11)."""
    base = site_url()
    link = f"{base}{path}" if base else ""
    subject = f"{title} — من {actor_name}" if actor_name else title
    lines = [title]
    if actor_name:
        lines.append(f"من: {actor_name}")
    if link:
        lines += ["", f"افتحه في النظام: {link}"]
    lines += ["", "لا ترد على هذا الإيميل — الرد والاعتماد من داخل النظام."]
    text = "\n".join(lines)

    e = html_lib.escape
    button = (
        f'<p style="margin:24px 0"><a href="{e(link)}" style="background:#28255F;color:#ffffff;'
        'padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">'
        "افتح في النظام</a></p>"
        if link
        else ""
    )
    html = (
        '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;color:#1f2937;'
        'max-width:520px;margin:0 auto;padding:24px;text-align:right">'
        f'<p style="font-size:17px;font-weight:bold;margin:0 0 8px">{e(title)}</p>'
        + (f'<p style="margin:0;color:#4b5563">من: {e(actor_name)}</p>' if actor_name else "")
        + button
        + '<p style="font-size:12px;color:#9ca3af;margin-top:24px">'
        "لا ترد على هذا الإيميل — الرد والاعتماد من داخل نظام المراسلات.</p></div>"
    )
    return subject, text, html
