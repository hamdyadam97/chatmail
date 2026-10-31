"""Due-date reminders: once per stage, primary recipients who have not
replied, sender told once when overdue; never for answered, closed,
archived or cc. Notifications stay generic (SEC-11)."""
from datetime import timedelta

import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.correspondence.models import Correspondence
from apps.correspondence.services import send_due_reminders
from apps.notifications.models import Notification
from apps.notifications.services import TITLES

from .correspondence_utils import (  # noqa: F401  (fixtures)
    CORR_URL,
    _blob_root,
    office,
    prepare_and_send,
    reply,
)

pytestmark = pytest.mark.django_db


def due_in(corr_id, days):
    Correspondence.objects.filter(id=corr_id).update(due_date=timezone.localdate() + timedelta(days=days))


def kinds(user, kind):
    return Notification.objects.filter(user=user, kind=kind).count()


def test_due_soon_reminds_primary_recipient_once(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]], [office["r2"]])
    due_in(root["id"], 1)
    assert send_due_reminders()["due_soon"] == 1
    assert send_due_reminders()["due_soon"] == 0  # once only
    assert kinds(office["r1"], "correspondence_due_soon") == 1
    assert kinds(office["r2"], "correspondence_due_soon") == 0  # cc is not asked to reply
    n = Notification.objects.get(user=office["r1"], kind="correspondence_due_soon")
    assert n.title_generic == TITLES["correspondence_due_soon"] and str(n.ref_id) == root["id"]


def test_far_due_date_is_quiet(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    due_in(root["id"], 5)
    assert send_due_reminders() == {"due_soon": 0, "overdue": 0, "overdue_sender": 0}


def test_overdue_tells_recipient_and_sender_once(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    due_in(root["id"], -1)
    assert send_due_reminders() == {"due_soon": 0, "overdue": 1, "overdue_sender": 1}
    assert send_due_reminders() == {"due_soon": 0, "overdue": 0, "overdue_sender": 0}
    assert kinds(office["r1"], "correspondence_overdue") == 1
    assert kinds(office["s"], "correspondence_overdue_sender") == 1


def test_answered_closed_or_archived_never_remind(api_client, office):
    answered = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    assert reply(api_client, office["h_r1"], answered["id"]).status_code == 201
    closed = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    assert api_client.post(f"{CORR_URL}{closed['id']}/close/", **office["h_s"]).status_code == 200
    archived = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    api_client.post(f"{CORR_URL}{archived['id']}/flags/", {"archived": True}, format="json", **office["h_r1"])
    for c in (answered, closed, archived):
        due_in(c["id"], -1)
    assert send_due_reminders() == {"due_soon": 0, "overdue": 0, "overdue_sender": 0}


def test_command_runs(api_client, office, capsys):
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    due_in(root["id"], 0)
    call_command("send_correspondence_reminders")
    assert "due soon: 1" in capsys.readouterr().out
