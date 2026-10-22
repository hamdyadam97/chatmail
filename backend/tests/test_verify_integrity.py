"""verify_integrity: the post-restore check passes on healthy data and
catches each kind of damage a bad backup/restore can cause."""
import uuid

import pytest
from django.core.management import call_command

from apps.correspondence.models import ReferenceSequence, StoredFile
from apps.correspondence.services import blob_storage
from apps.messaging.models import Conversation, Message

from .correspondence_utils import (  # noqa: F401  (fixtures)
    _blob_root,
    encrypted_blob,
    office,
    prepare_and_send,
    upload,
)

pytestmark = pytest.mark.django_db


@pytest.fixture
def healthy(api_client, office):
    blob_id = upload(api_client, office["h_s"], encrypted_blob(2048)).json()["id"]
    prepare_and_send(api_client, office["h_s"], office["d_s"], [office["r1"]], attachment_ids=[blob_id])
    return StoredFile.objects.get(id=blob_id)


def run(capsys, *args):
    try:
        call_command("verify_integrity", *args)
        code = 0
    except SystemExit as exc:
        code = exc.code
    return code, capsys.readouterr().out


def test_passes_on_healthy_data(healthy, capsys):
    code, out = run(capsys)
    assert code == 0, out
    assert "[OK] blobs: 1 blob(s)" in out
    assert "all integrity checks passed" in out


def test_detects_tampered_blob(healthy, capsys):
    path = blob_storage().path(healthy.storage_key)
    with open(path, "r+b") as fh:
        fh.seek(20)
        byte = fh.read(1)
        fh.seek(20)
        fh.write(bytes([byte[0] ^ 1]))
    code, out = run(capsys)
    assert code == 1 and "[FAIL] blobs" in out and "hash mismatch" in out


def test_detects_missing_blob(healthy, capsys):
    blob_storage().delete(healthy.storage_key)
    code, out = run(capsys)
    assert code == 1 and "missing" in out
    # the fast mode skips hashing but still checks the rest
    code, out = run(capsys, "--skip-blobs")
    assert code == 0, out


def test_detects_plaintext_written_around_the_api(healthy, capsys):
    conv = Conversation.objects.filter(type="correspondence").first()
    Message.objects.create(
        conversation=conv, seq=999, epoch=1, kind="application",
        mls_payload=b'{"subject": "plain"}', client_msg_id=uuid.uuid4(),
    )
    code, out = run(capsys)
    assert code == 1 and "[FAIL] ciphertext" in out


def test_detects_counter_behind_issued_numbers(healthy, capsys):
    ReferenceSequence.objects.update(last_seq=0)  # e.g. an older sequence table restored
    code, out = run(capsys)
    assert code == 1 and "[FAIL] sequences" in out
