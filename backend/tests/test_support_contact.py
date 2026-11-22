"""The support WhatsApp number: from the environment only (public repository),
normalized for wa.me, and readable without signing in (the login page shows it)."""
import pytest
from rest_framework.test import APIClient

from config.settings.base import _whatsapp_number

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize("raw, expected", [
    ("0512345678", "966512345678"),
    ("+966 51 234 5678", "966512345678"),
    ("00966512345678", "966512345678"),
    ("", ""),
    ("abc", ""),
])
def test_number_is_normalized_for_whatsapp(raw, expected):
    assert _whatsapp_number(raw) == expected


def test_public_endpoint(settings):
    settings.SUPPORT_WHATSAPP = "966500000000"
    r = APIClient().get("/api/v1/auth/support/", HTTP_AUTHORIZATION="Bearer junk")
    assert r.status_code == 200 and r.json() == {"whatsapp": "966500000000"}
    settings.SUPPORT_WHATSAPP = ""
    assert APIClient().get("/api/v1/auth/support/").json() == {"whatsapp": None}
