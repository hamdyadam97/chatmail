"""Central institutional archive: a declared reader, not a back door.

* only central archive officers list and open archived items;
* only correspondence the sender classified ``institutional_archive_eligible``
  is visible there (replies inherit the classification);
* every opening is audited;
* attachments of archived items are downloadable by officers — nothing else.
"""
import pytest

from apps.audit.models import AuditLog

from .conftest import assign_role
from .correspondence_utils import (  # noqa: F401  (fixtures)
    ATT_URL,
    _blob_root,
    office,
    prepare_and_send,
    reply,
    upload,
)
from .messaging_utils import auth

pytestmark = pytest.mark.django_db
ARCH = "/api/v1/archive/"
ELIGIBLE = "institutional_archive_eligible"


@pytest.fixture
def officer(api_client, user_factory):
    user = user_factory("arch_officer")
    assign_role(user, "archive_officer")  # central
    return {"user": user, "h": auth(api_client, "arch_officer")}


def _items(api_client, h, q=""):
    r = api_client.get(f"{ARCH}items/?q={q}", **h)
    assert r.status_code == 200, r.content
    return r.json()["results"]


def test_officer_status(officer, api_client, office):
    assert api_client.get(ARCH, **officer["h"]).json() == {"is_officer": True}
    assert api_client.get(ARCH, **office["h_s"]).json() == {"is_officer": False}


def test_only_eligible_items_and_replies_are_archived(officer, api_client, office):
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]], classification=ELIGIBLE,
                            subject="عقد الصيانة")
    prepare_and_send(api_client, office["h_s"], [office["r1"]], subject="عادية")
    rep = reply(api_client, office["h_r1"], root["id"], body="موافق").json()
    assert rep["classification"] == ELIGIBLE
    ids = {i["correspondence_id"] for i in _items(api_client, officer["h"])}
    assert ids == {root["id"], rep["id"]}
    assert [i["correspondence_id"] for i in _items(api_client, officer["h"], "الصيانة")] == [root["id"]]


def test_only_officers_open_items_and_opening_is_audited(officer, api_client, office):
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]], classification=ELIGIBLE, body="بنود العقد")
    assert api_client.get(f"{ARCH}items/", **office["h_r1"]).status_code == 403
    assert api_client.get(f"{ARCH}items/{root['id']}/", **office["h_r1"]).status_code == 403
    item = api_client.get(f"{ARCH}items/{root['id']}/", **officer["h"])
    assert item.status_code == 200 and item.json()["body"] == "بنود العقد"
    assert AuditLog.objects.filter(action="archive_copy_viewed", actor=officer["user"],
                                   target_id=root["id"]).count() == 1


def test_no_access_to_non_archived_correspondence(officer, api_client, office):
    normal = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    assert api_client.get(f"{ARCH}items/{normal['id']}/", **officer["h"]).status_code == 404
    assert api_client.get(f"/api/v1/correspondences/{normal['id']}/", **officer["h"]).status_code == 403


def test_officer_downloads_attachments_of_archived_items_only(officer, api_client, office):
    archived_file = upload(api_client, office["h_s"]).json()["id"]
    normal_file = upload(api_client, office["h_s"]).json()["id"]
    prepare_and_send(api_client, office["h_s"], [office["r1"]], classification=ELIGIBLE,
                     attachment_ids=[archived_file])
    prepare_and_send(api_client, office["h_s"], [office["r1"]], attachment_ids=[normal_file])
    assert api_client.get(f"{ATT_URL}{archived_file}/", **officer["h"]).status_code == 200
    assert api_client.get(f"{ATT_URL}{normal_file}/", **officer["h"]).status_code == 403
