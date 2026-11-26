"""The executive receives every announcement as an observer (user decision
2026-11-26): reads the content and is notified, but stays out of compliance,
acknowledgement and reminders. Read access is still a recipient row — no
"view all" permission."""
import importlib

import pytest

from apps.announcements import services
from apps.announcements.models import AnnouncementRecipient
from apps.notifications.models import Notification

from .conftest import assign_role
from .correspondence_utils import make_employee
from .messaging_utils import auth
from .test_announcements import ANN_URL, ack, org, published  # noqa: F401  (org is a fixture)

pytestmark = pytest.mark.django_db


@pytest.fixture
def exe(user_factory, org):  # noqa: F811
    u = make_employee(user_factory, "a_exe", org["branch_a2"])  # outside the branch_a audience
    assign_role(u, "executive")
    return u


def test_executive_reads_every_announcement_but_is_not_counted(api_client, org, exe):  # noqa: F811
    ann = published(api_client, org)
    row = AnnouncementRecipient.objects.get(announcement_id=ann["id"], user=exe)
    assert row.observer is True
    assert Notification.objects.filter(kind="announcement", ref_id=ann["id"], user=exe).exists()
    assert ann["recipient_count"] == 3

    h = auth(api_client, "a_exe")
    detail = api_client.get(f"{ANN_URL}{ann['id']}/", **h).json()
    assert detail["content"]["title"] == "تعميم الدوام"
    assert detail["mine"]["observer"] is True
    assert api_client.post(f"{ANN_URL}{ann['id']}/read/", **h).status_code == 204
    assert ack(api_client, h, ann).status_code == 400  # never asked to acknowledge
    assert api_client.get(f"{ANN_URL}?box=received&pending_ack=1", **h).json()["results"] == []
    assert [i["id"] for i in api_client.get(f"{ANN_URL}?box=received", **h).json()["results"]] == [ann["id"]]

    rep = api_client.get(f"{ANN_URL}{ann['id']}/compliance/", **org["h_pub"]).json()
    assert rep["total"] == 3 and "a_exe" not in {r["user"]["username"] for r in rep["rows"]}
    aud = api_client.get(f"{ANN_URL}{ann['id']}/audience/", **org["h_e1"]).json()
    assert "a_exe" not in {u["username"] for u in aud["recipients"]}
    assert [u["username"] for u in aud["observers"]] == ["a_exe"]

    assert api_client.post(f"{ANN_URL}{ann['id']}/remind/", **org["h_pub"]).json() == {"reminded": 3}
    assert not Notification.objects.filter(kind="announcement_reminder", user=exe).exists()

    # The tracking box counts the audience only, and shows the executive the content.
    tracking = api_client.get(f"{ANN_URL}?box=tracking", **h).json()["results"]
    [t] = [r for r in tracking if r["id"] == ann["id"]]
    assert t["counts"]["recipients"] == 3 and t["content"]["title"] == "تعميم الدوام"


def test_executive_in_the_audience_stays_a_normal_recipient(api_client, user_factory, org):  # noqa: F811
    inside = make_employee(user_factory, "a_exe_in", org["branch_a"])
    assign_role(inside, "executive")
    ann = published(api_client, org)
    row = AnnouncementRecipient.objects.get(announcement_id=ann["id"], user=inside)
    assert row.observer is False and ann["recipient_count"] == 4


def test_new_executive_gets_earlier_announcements(api_client, user_factory, org):  # noqa: F811
    ann = published(api_client, org)
    later = make_employee(user_factory, "a_exe_new", org["branch_a2"])
    h = auth(api_client, "a_exe_new")
    assert api_client.get(f"{ANN_URL}{ann['id']}/", **h).status_code == 403
    assert services.add_observer_to_all(later) == 0  # not an executive yet
    assign_role(later, "executive")
    assert services.add_observer_to_all(later) == 1
    assert services.add_observer_to_all(later) == 0  # idempotent
    assert api_client.get(f"{ANN_URL}{ann['id']}/", **h).json()["content"]["title"] == "تعميم الدوام"
    assert not Notification.objects.filter(kind="announcement", user=later).exists()  # no backlog noise


def test_migration_backfills_existing_announcements(api_client, user_factory, org):  # noqa: F811
    ann = published(api_client, org)
    old = make_employee(user_factory, "a_exe_old", org["branch_a2"])
    assign_role(old, "executive")
    from django.apps import apps as django_apps

    mod = importlib.import_module("apps.announcements.migrations.0004_executive_observer")
    mod.add_existing(django_apps, None)
    assert AnnouncementRecipient.objects.get(announcement_id=ann["id"], user=old).observer is True


def test_branch_manager_is_not_an_observer(api_client, user_factory, org):  # noqa: F811
    boss = make_employee(user_factory, "a_boss_x", org["branch_a2"])
    assign_role(boss, "branch_manager", branch=org["branch_a2"])
    ann = published(api_client, org)
    assert not AnnouncementRecipient.objects.filter(announcement_id=ann["id"], user=boss).exists()
