"""Transparency chains are per user: verification over the whole table (the
post-deploy verify_integrity and the health page) must walk each user's
chain on its own — a second user's genesis entry is not a broken link."""
import pytest
from django.core.management import call_command

from apps.crypto_keys.models import KeyTransparencyEvent
from apps.crypto_keys.transparency import verify_all_chains
from apps.reports.services import health

pytestmark = pytest.mark.django_db


@pytest.fixture
def two_users(bootstrapped_user_factory):
    bootstrapped_user_factory("chain_a")
    bootstrapped_user_factory("chain_b")
    assert KeyTransparencyEvent.objects.values("user").distinct().count() == 2


def test_two_users_chains_verify(two_users, capsys):
    assert verify_all_chains(list(KeyTransparencyEvent.objects.order_by("id"))) == []
    call_command("verify_integrity", "--skip-blobs")
    assert "[FAIL]" not in capsys.readouterr().out
    assert health()["checks"]["key_transparency"]["ok"] is True


def test_tampering_in_one_chain_is_still_caught(two_users):
    victim = KeyTransparencyEvent.objects.filter(user__username="chain_b").order_by("id").first()
    from django.db import connection

    with connection.cursor() as cur:
        cur.execute("UPDATE key_transparency_events SET payload = %s WHERE id = %s", ['{"forged": true}', victim.pk])
    problems = verify_all_chains(list(KeyTransparencyEvent.objects.order_by("id")))
    assert problems and str(victim.pk) in problems[0]
