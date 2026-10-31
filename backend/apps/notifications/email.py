"""Plain-text system e-mail through Brevo (the same account as external
mail). Silent no-op when Brevo or the mail domain is not configured; failures
are logged without the message text."""
import logging

from django.conf import settings
from django.db import transaction

logger = logging.getLogger(__name__)


def configured() -> bool:
    return bool(settings.BREVO_API_KEY and settings.EXTERNAL_MAIL_DOMAIN)


def send_email(to: list[str], subject: str, text: str) -> None:
    """Queued after the surrounding transaction commits."""
    to = [a for a in dict.fromkeys(to) if a]
    if not to or not configured():
        return

    def _send():
        import requests

        try:
            resp = requests.post(
                f"{settings.BREVO_API_BASE.rstrip('/')}/v3/smtp/email",
                json={
                    "sender": {"name": "نظام المراسلات", "email": f"no-reply@{settings.EXTERNAL_MAIL_DOMAIN}"},
                    "to": [{"email": a} for a in to],
                    "subject": subject,
                    "textContent": text,
                },
                headers={"api-key": settings.BREVO_API_KEY, "accept": "application/json"},
                timeout=20,
            )
            if resp.status_code >= 300:
                logger.warning("system e-mail rejected by Brevo (status=%s)", resp.status_code)
        except requests.RequestException:
            logger.warning("system e-mail could not reach Brevo")

    transaction.on_commit(_send)
