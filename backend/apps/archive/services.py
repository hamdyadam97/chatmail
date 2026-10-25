"""Central archive: key lifecycle, key sharing between officers, copies.

Who is an archive officer: a CENTRAL assignment of
``archive.institutional.access`` (the archive_officer role). Every read of
an archived item is audited. The server never sees the archive private key
nor plaintext — only ciphertext, public keys and signatures.
"""
import base64
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from django.db import IntegrityError, transaction
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.accounts.models import TrustedDevice
from apps.authorization.services import has_permission
from apps.crypto_keys import transparency
from apps.crypto_keys.services import Conflict, b64decode_field, b64encode

from .models import ArchiveCopy, ArchiveKey, ArchiveKeyShare

ARCHIVE_PERMISSION = "archive.institutional.access"
ARCHIVE_KEY_CONTEXT = b"corr-archive-key-v1\n"
ARCHIVE_ELIGIBLE = "institutional_archive_eligible"
MAX_COPY_BYTES = 2 * 1024 * 1024  # subject + body + attachment keys; files stay separate blobs


def is_officer(user) -> bool:
    return has_permission(user, ARCHIVE_PERMISSION, unit=None)


def require_officer(user) -> None:
    if not is_officer(user):
        raise PermissionDenied("الأرشيف المركزي متاح لضباط الأرشيف المعتمدين فقط.")


def _uuid(value, field):
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        raise ValidationError({field: "معرّف غير صالح."})


def _own_active_device(user, device_id) -> TrustedDevice:
    device = TrustedDevice.objects.filter(user=user, id=_uuid(device_id, "device_id")).first()
    if device is None or device.status != "active" or device.identity_sign_pub is None:
        raise PermissionDenied("يلزم جهاز موثّق نشط.")
    return device


def active_key() -> ArchiveKey | None:
    return ArchiveKey.objects.filter(status="active").select_related("created_by", "created_by_device").first()


def next_version() -> int:
    return (ArchiveKey.objects.order_by("-version").values_list("version", flat=True).first() or 0) + 1


def key_signing_message(version: int, public_key: bytes) -> bytes:
    return ARCHIVE_KEY_CONTEXT + str(version).encode() + b"\n" + public_key


def key_to_dict(key: ArchiveKey) -> dict:
    return {
        "id": str(key.id),
        "version": key.version,
        "public_key": b64encode(key.public_key),
        "created_by": key.created_by.full_name or key.created_by.username,
        "created_at": key.created_at.isoformat(),
        "signer_sign_pub": b64encode(key.created_by_device.identity_sign_pub),
        "signature": b64encode(key.signature),
    }


# --- key lifecycle --------------------------------------------------------------------------

@transaction.atomic
def create_key(user, *, device_id, public_key_b64: str, signature_b64: str) -> ArchiveKey:
    require_officer(user)
    device = _own_active_device(user, device_id)
    if ArchiveKey.objects.filter(status="active").exists():
        raise Conflict("يوجد مفتاح أرشيف نشط بالفعل.")
    public_key = b64decode_field(public_key_b64, "public_key", 32)
    signature = b64decode_field(signature_b64, "signature", 64)
    version = next_version()
    try:
        Ed25519PublicKey.from_public_bytes(bytes(device.identity_sign_pub)).verify(
            signature, key_signing_message(version, public_key)
        )
    except (InvalidSignature, ValueError):
        raise PermissionDenied({"signature": "توقيع الجهاز غير صالح."})
    try:
        key = ArchiveKey.objects.create(
            version=version, public_key=public_key, created_by=user, created_by_device=device, signature=signature
        )
    except IntegrityError:
        raise Conflict("يوجد مفتاح أرشيف نشط بالفعل.")
    transparency.append_event(
        "archive_key_created",
        user=user,
        device=device,
        payload={
            "archive_key_id": str(key.id),
            "version": version,
            "archive_public_key_hash": transparency.hash_bytes(public_key),
            "device_id": str(device.id),
        },
    )
    return key


def officer_devices_status(key: ArchiveKey) -> list[dict]:
    """Every active, keyed device of every central archive officer, and
    whether it already holds the archive key."""
    from apps.authorization.models import UserRoleAssignment

    officer_ids = {
        a.user_id
        for a in UserRoleAssignment.objects.filter(
            role__role_permissions__permission__code=ARCHIVE_PERMISSION,
            institute__isnull=True, branch__isnull=True, department__isnull=True,
        ).select_related("user")
        if is_officer(a.user)
    }
    shared = set(ArchiveKeyShare.objects.filter(archive_key=key).values_list("recipient_device_id", flat=True))
    devices = TrustedDevice.objects.filter(
        user_id__in=officer_ids, status="active", identity_sign_pub__isnull=False
    ).select_related("user").order_by("user__username", "created_at")
    return [
        {
            "device_id": str(d.id),
            "label": d.device_label,
            "user": d.user.full_name or d.user.username,
            "kem_pub": b64encode(d.kem_pub),
            "has_key": d.id == key.created_by_device_id or d.id in shared,
        }
        for d in devices
    ]


@transaction.atomic
def share_key(user, *, key_id, recipient_device_id, ephemeral_pub_b64, iv_b64, ciphertext_b64) -> ArchiveKeyShare:
    """An officer who holds the key passes it to another officer's device."""
    require_officer(user)
    key = ArchiveKey.objects.filter(id=_uuid(key_id, "key_id"), status="active").first()
    if key is None:
        raise ValidationError({"key_id": "لا يوجد مفتاح أرشيف نشط بهذا المعرّف."})
    recipient = TrustedDevice.objects.filter(
        id=_uuid(recipient_device_id, "recipient_device_id"), status="active", identity_sign_pub__isnull=False
    ).select_related("user").first()
    if recipient is None or not is_officer(recipient.user):
        raise PermissionDenied("الجهاز المستلم ليس جهازًا نشطًا لضابط أرشيف.")
    try:
        return ArchiveKeyShare.objects.create(
            archive_key=key,
            recipient_device=recipient,
            shared_by=user,
            ephemeral_pub=b64decode_field(ephemeral_pub_b64, "ephemeral_pub", 32),
            iv=b64decode_field(iv_b64, "iv", 12),
            ciphertext=b64decode_field(ciphertext_b64, "ciphertext"),
        )
    except IntegrityError:
        raise Conflict("هذا الجهاز يملك المفتاح بالفعل.")


def my_share(user, device_id) -> ArchiveKeyShare | None:
    require_officer(user)
    device = _own_active_device(user, device_id)
    key = active_key()
    if key is None:
        return None
    return ArchiveKeyShare.objects.filter(archive_key=key, recipient_device=device).first()


# --- copies (written by the sender inside send_correspondence) ----------------------------

def parse_copy(data) -> dict | None:
    if data in (None, ""):
        return None
    if not isinstance(data, dict):
        raise ValidationError({"archive_copy": "صيغة غير صالحة."})
    ciphertext = b64decode_field(data.get("ciphertext"), "archive_copy.ciphertext")
    if len(ciphertext) > MAX_COPY_BYTES:
        raise ValidationError({"archive_copy": "النسخة أكبر من المسموح."})
    return {
        "key_id": _uuid(data.get("key_id"), "archive_copy.key_id"),
        "ephemeral_pub": b64decode_field(data.get("ephemeral_pub"), "archive_copy.ephemeral_pub", 32),
        "iv": b64decode_field(data.get("iv"), "archive_copy.iv", 12),
        "ciphertext": ciphertext,
    }


def check_copy(correspondence, copy: dict | None) -> None:
    """Validate BEFORE the send transaction (sending broadcasts immediately).
    Archive-eligible items MUST carry a copy for the active key; other items
    must not carry one."""
    if correspondence.classification != ARCHIVE_ELIGIBLE:
        if copy is not None:
            raise ValidationError({"archive_copy": "المراسلة غير مصنّفة للأرشفة المؤسسية."})
        return
    key = active_key()
    if key is None:
        raise ValidationError({"archive_copy": "الأرشيف المركزي غير مُهيأ بعد — لا يمكن إرسال مراسلة مصنّفة للأرشفة."})
    if copy is None:
        raise ValidationError({"archive_copy": "المراسلة مصنّفة للأرشفة المؤسسية: نسخة الأرشيف المشفّرة مطلوبة."})
    if copy["key_id"] != key.id:
        raise ValidationError({"archive_copy": "نسخة الأرشيف مشفّرة لمفتاح غير نشط — أعد المحاولة."})


def attach_copy(correspondence, copy: dict | None) -> ArchiveCopy | None:
    """Inside the send transaction, after check_copy passed."""
    if correspondence.classification != ARCHIVE_ELIGIBLE or copy is None:
        return None
    key = ArchiveKey.objects.get(id=copy["key_id"])
    return ArchiveCopy.objects.create(
        correspondence=correspondence,
        archive_key=key,
        ephemeral_pub=copy["ephemeral_pub"],
        iv=copy["iv"],
        ciphertext=copy["ciphertext"],
    )


def copy_to_dict(copy: ArchiveCopy, *, with_ciphertext: bool) -> dict:
    c = copy.correspondence
    membership = c.sender_membership
    data = {
        "correspondence_id": str(c.id),
        "reference_number": c.reference_number,
        "sent_at": c.sent_at.isoformat() if c.sent_at else None,
        "sender": c.sender.full_name or c.sender.username,
        "institute": membership.institute.name if membership and membership.institute_id else None,
        "priority": c.priority,
        "reply_to_id": str(c.reply_to_id) if c.reply_to_id else None,
        "thread_id": str(c.thread_id),
        "key_id": str(copy.archive_key_id),
        "size": len(bytes(copy.ciphertext)),
        "archived_at": copy.created_at.isoformat(),
    }
    if with_ciphertext:
        data.update(
            client_msg_id=str(c.content_message.client_msg_id),
            ephemeral_pub=b64encode(copy.ephemeral_pub),
            iv=b64encode(copy.iv),
            ciphertext=base64.b64encode(bytes(copy.ciphertext)).decode("ascii"),
            attachments=[
                {"id": str(a.stored_file_id), "size": a.stored_file.ciphertext_size}
                for a in c.attachments.select_related("stored_file")
            ],
        )
    return data


def copies_queryset():
    return ArchiveCopy.objects.select_related(
        "correspondence", "correspondence__sender", "correspondence__sender_membership__institute"
    ).order_by("-created_at")


def officer_may_download(user, stored_file) -> bool:
    """Attachments of archived correspondence are downloadable (still
    ciphertext; the key travels in the archive copy) by archive officers."""
    from apps.correspondence.models import EncryptedAttachment

    return is_officer(user) and EncryptedAttachment.objects.filter(
        stored_file=stored_file, correspondence__archive_copy__isnull=False
    ).exists()
