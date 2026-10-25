"""Central institutional archive: declared recipient, not a back door.

* only central archive officers create/hold the key and read copies;
* archive-eligible correspondence cannot be sent without a sender-made copy
  (validated before anything is stored or broadcast), others cannot carry one;
* replies inherit the classification; every opening is audited;
* attachments of archived items are downloadable by officers — nothing else.
"""
import os
import uuid

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import TrustedDevice
from apps.archive import services as archive
from apps.archive.models import ArchiveCopy
from apps.audit.models import AuditLog
from apps.correspondence.models import Correspondence
from apps.crypto_keys.models import KeyTransparencyEvent

from .conftest import assign_role, b64e, login_and_get_access, make_device_keys, register_device_payload
from .correspondence_utils import (  # noqa: F401  (fixtures)
    CORR_URL,
    _blob_root,
    b64,
    mls_payload,
    office,
    prepare,
    reply,
    setup_thread,
    upload,
    encrypted_blob,
)
from .messaging_utils import auth

pytestmark = pytest.mark.django_db
ARCH = "/api/v1/archive/"
ELIGIBLE = "institutional_archive_eligible"


@pytest.fixture
def officer(bootstrapped_user_factory, api_client):
    user, keys, identity_pub = bootstrapped_user_factory("arch_officer")
    api_client.credentials()  # the factory logs in on the shared client; tests pass headers explicitly
    assign_role(user, "archive_officer")  # central
    device = TrustedDevice.objects.get(user=user, identity_sign_pub=keys.sign_pub)
    client = APIClient()
    login_and_get_access(client, "arch_officer")
    return {"user": user, "keys": keys, "identity_pub": identity_pub, "device": device, "client": client}


def create_key(o, *, keys=None):
    pub = os.urandom(32)
    sig = (keys or o["keys"]).sign_priv.sign(archive.key_signing_message(1, pub))
    return o["client"].post(
        f"{ARCH}key/", {"device_id": str(o["device"].id), "public_key": b64e(pub), "signature": b64e(sig)},
        format="json",
    )


def copy_for(key_id):
    return {"key_id": str(key_id), "ephemeral_pub": b64(os.urandom(32)), "iv": b64(os.urandom(12)),
            "ciphertext": b64(os.urandom(200))}


def send_eligible(client, office, *, copy=None, attachment_ids=()):
    prepared = prepare(client, office["h_s"], [office["r1"]], classification=ELIGIBLE).json()
    setup_thread(client, office["h_s"], prepared["thread"]["id"], office["d_s"])
    body = {
        "mls_payload": b64(mls_payload()), "client_msg_id": str(uuid.uuid4()), "epoch": 1,
        "sender_device_id": str(office["d_s"]), "attachment_ids": [str(a) for a in attachment_ids],
        "archive_copy": copy,
    }
    return prepared, client.post(f"{CORR_URL}{prepared['id']}/send/", body, format="json", **office["h_s"])


# --- key ------------------------------------------------------------------------------------

def test_only_officers_create_one_signed_key(officer, api_client, office):
    other = APIClient()
    login_and_get_access(other, "c_sender")
    assert other.post(f"{ARCH}key/", {"device_id": str(office["d_s"]), "public_key": b64e(os.urandom(32)),
                                      "signature": b64e(os.urandom(64))}, format="json").status_code == 403
    assert create_key(officer, keys=make_device_keys()).status_code == 403  # not signed by this device
    r = create_key(officer)
    assert r.status_code == 201, r.content
    assert create_key(officer).status_code == 409
    assert KeyTransparencyEvent.objects.filter(user=officer["user"], event_type="archive_key_created").exists()
    public = api_client.get(f"{ARCH}key/", **office["h_s"]).json()  # every sender can read the public key
    assert public["key"]["id"] == r.json()["id"] and public["is_officer"] is False and public["devices"] == []


def test_key_is_shared_only_between_officer_devices(officer, bootstrapped_user_factory, office, api_client):
    key_id = create_key(officer).json()["id"]
    officer2, keys2, _ = bootstrapped_user_factory("arch_officer2")
    api_client.credentials()
    assign_role(officer2, "archive_officer")
    dev2 = TrustedDevice.objects.get(user=officer2, identity_sign_pub=keys2.sign_pub)
    status = officer["client"].get(f"{ARCH}key/").json()["devices"]
    assert {d["device_id"]: d["has_key"] for d in status} == {str(officer["device"].id): True, str(dev2.id): False}

    share = {"key_id": key_id, "ephemeral_pub": b64(os.urandom(32)), "iv": b64(os.urandom(12)),
             "ciphertext": b64(os.urandom(48))}
    # a plain employee's device can never receive the archive key
    assert officer["client"].post(f"{ARCH}key/shares/", {**share, "recipient_device_id": str(office["d_s"])},
                                  format="json").status_code == 403
    assert officer["client"].post(f"{ARCH}key/shares/", {**share, "recipient_device_id": str(dev2.id)},
                                  format="json").status_code == 201
    c2 = APIClient()
    login_and_get_access(c2, "arch_officer2")
    mine = c2.get(f"{ARCH}key/shares/mine/?device_id={dev2.id}")
    assert mine.status_code == 200 and mine.json()["key_id"] == key_id
    plain = APIClient()
    login_and_get_access(plain, "c_sender")
    assert plain.get(f"{ARCH}key/shares/mine/?device_id={office['d_s']}").status_code == 403


# --- copies at send time ------------------------------------------------------------------------

def test_eligible_needs_initialized_archive_and_a_copy(officer, api_client, office):
    prepared, r = send_eligible(api_client, office, copy=None)
    assert r.status_code == 400 and "غير مُهيأ" in str(r.json())
    assert Correspondence.objects.get(id=prepared["id"]).status == "draft"  # nothing sent or broadcast
    key_id = create_key(officer).json()["id"]
    prepared, r = send_eligible(api_client, office, copy=None)
    assert r.status_code == 400 and Correspondence.objects.get(id=prepared["id"]).status == "draft"
    prepared, r = send_eligible(api_client, office, copy=copy_for(uuid.uuid4()))  # wrong key
    assert r.status_code == 400
    prepared, r = send_eligible(api_client, office, copy=copy_for(key_id))
    assert r.status_code == 200, r.content
    assert ArchiveCopy.objects.filter(correspondence_id=prepared["id"]).exists()


def test_normal_correspondence_cannot_carry_a_copy(officer, api_client, office):
    key_id = create_key(officer).json()["id"]
    prepared = prepare(api_client, office["h_s"], [office["r1"]]).json()
    setup_thread(api_client, office["h_s"], prepared["thread"]["id"], office["d_s"])
    body = {"mls_payload": b64(mls_payload()), "client_msg_id": str(uuid.uuid4()), "epoch": 1,
            "sender_device_id": str(office["d_s"]), "archive_copy": copy_for(key_id)}
    assert api_client.post(f"{CORR_URL}{prepared['id']}/send/", body, format="json", **office["h_s"]).status_code == 400


def test_reply_inherits_classification_and_needs_a_copy(officer, api_client, office):
    key_id = create_key(officer).json()["id"]
    root, r = send_eligible(api_client, office, copy=copy_for(key_id))
    assert r.status_code == 200
    assert reply(api_client, office["h_r1"], root["id"], office["d_r1"]).status_code == 400
    body = {"client_ref": str(uuid.uuid4()), "mls_payload": b64(mls_payload()), "client_msg_id": str(uuid.uuid4()),
            "epoch": 1, "sender_device_id": str(office["d_r1"]), "archive_copy": copy_for(key_id)}
    ok = api_client.post(f"{CORR_URL}{root['id']}/reply/", body, format="json", **office["h_r1"])
    assert ok.status_code == 201, ok.content
    assert ArchiveCopy.objects.filter(correspondence_id=ok.json()["id"]).exists()


# --- reading the archive --------------------------------------------------------------------------

def test_only_officers_list_and_open_copies_and_opening_is_audited(officer, api_client, office):
    key_id = create_key(officer).json()["id"]
    root, _ = send_eligible(api_client, office, copy=copy_for(key_id))
    assert api_client.get(f"{ARCH}copies/", **office["h_s"]).status_code == 403  # not even the sender
    assert api_client.get(f"{ARCH}copies/{root['id']}/", **office["h_r1"]).status_code == 403
    listing = officer["client"].get(f"{ARCH}copies/").json()
    assert [c["correspondence_id"] for c in listing["results"]] == [root["id"]]
    assert "ciphertext" not in listing["results"][0]
    detail = officer["client"].get(f"{ARCH}copies/{root['id']}/").json()
    assert detail["ciphertext"] and detail["client_msg_id"]
    assert AuditLog.objects.filter(action="archive_copy_viewed", actor=officer["user"], target_id=root["id"]).exists()


def test_officer_downloads_attachments_of_archived_items_only(officer, api_client, office):
    key_id = create_key(officer).json()["id"]
    archived_file = upload(api_client, office["h_s"], encrypted_blob()).json()["id"]
    send_eligible(api_client, office, copy=copy_for(key_id), attachment_ids=[archived_file])
    other_file = upload(api_client, office["h_s"], encrypted_blob()).json()["id"]
    prepared = prepare(api_client, office["h_s"], [office["r1"]]).json()
    setup_thread(api_client, office["h_s"], prepared["thread"]["id"], office["d_s"])
    body = {"mls_payload": b64(mls_payload()), "client_msg_id": str(uuid.uuid4()), "epoch": 1,
            "sender_device_id": str(office["d_s"]), "attachment_ids": [other_file]}
    assert api_client.post(f"{CORR_URL}{prepared['id']}/send/", body, format="json", **office["h_s"]).status_code == 200
    assert officer["client"].get(f"/api/v1/attachments/{archived_file}/").status_code == 200
    assert officer["client"].get(f"/api/v1/attachments/{other_file}/").status_code == 403


def test_no_access_to_non_archived_correspondence(officer, api_client, office):
    prepared = prepare(api_client, office["h_s"], [office["r1"]]).json()
    setup_thread(api_client, office["h_s"], prepared["thread"]["id"], office["d_s"])
    body = {"mls_payload": b64(mls_payload()), "client_msg_id": str(uuid.uuid4()), "epoch": 1,
            "sender_device_id": str(office["d_s"])}
    api_client.post(f"{CORR_URL}{prepared['id']}/send/", body, format="json", **office["h_s"])
    assert officer["client"].get(f"{ARCH}copies/{prepared['id']}/").status_code == 404
    assert officer["client"].get(f"{CORR_URL}{prepared['id']}/").status_code in (403, 404)
