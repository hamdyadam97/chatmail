"""Business logic for identity bootstrap, device lifecycle and key bundles.

Separation of duties: this module owns state changes + transparency-log
appends (transactional, via transparency.append_event); the API views own
HTTP concerns and audit logging (apps.audit.services.log), matching the
existing accounts/org layout.

Verification primitive (docs/phase1/03-key-management.md §3.2): a device
proves possession of its Ed25519 identity key by signing

    identity_pub || sign_pub || kem_pub || user.id.bytes

and the server verifies with the presented sign_pub (cryptography, pure
Python). user.id.bytes is the 16-byte UUID — domain separation between users.
"""
import base64
import hashlib

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError

from apps.accounts.models import TrustedDevice, User, UserSession

from . import transparency
from .models import DeviceKeyBundle, UserCryptoIdentity

DEVICE_SIGN_PUB_LEN = 32
KEM_PUB_LEN = 32
IDENTITY_SIGN_PUB_LEN = 32
ED25519_SIGNATURE_LEN = 64


class Conflict(APIException):
    status_code = 409
    default_detail = "تعارض مع حالة موجودة."
    default_code = "conflict"


def b64decode_field(value, field: str, expected_len: int | None = None) -> bytes:
    """Strict base64 decode for a request field; 400 on malformed input."""
    if not isinstance(value, str) or not value:
        raise ValidationError({field: "قيمة base64 غير صالحة."})
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception:
        raise ValidationError({field: "قيمة base64 غير صالحة."})
    if expected_len is not None and len(raw) != expected_len:
        raise ValidationError({field: f"يجب أن يكون الطول {expected_len} بايت."})
    return raw


def b64encode(raw: bytes) -> str:
    return base64.b64encode(bytes(raw)).decode("ascii")


def verify_device_signature(*, identity_pub: bytes, sign_pub: bytes, kem_pub: bytes,
                            user_id_bytes: bytes, signature: bytes) -> None:
    """Verify the device attestation signature; 400 if it does not verify."""
    message = identity_pub + sign_pub + kem_pub + user_id_bytes
    try:
        Ed25519PublicKey.from_public_bytes(sign_pub).verify(signature, message)
    except (InvalidSignature, ValueError):
        raise ValidationError({"sig": "توقيع الجهاز غير صالح."})


def request_session(request) -> UserSession | None:
    """Resolve the caller's access-token session (sid claim) if it is still
    active (not revoked, not expired)."""
    sid = request.auth.get("sid") if isinstance(request.auth, dict) else None
    if not sid:
        return None
    session = UserSession.objects.filter(id=sid).select_related("device").first()
    if session is None:
        return None
    if session.revoked_at is not None or session.expires_at <= timezone.now():
        return None
    return session


def _device_payload(device: TrustedDevice) -> dict:
    return {
        "user_id": str(device.user_id),
        "device_id": str(device.id),
        "device_sign_pub_hash": transparency.hash_bytes(device.identity_sign_pub),
        "device_kem_pub_hash": transparency.hash_bytes(device.kem_pub),
    }


@transaction.atomic
def bootstrap_identity(user, request, *, identity_pub: bytes, bootstrap_sig: bytes,
                       device_data: dict) -> tuple[UserCryptoIdentity, TrustedDevice]:
    """First-device bootstrap: create the user's crypto identity and bind the
    FIRST trusted device (status=active).

    The device row is the caller's current session device (updated with the
    supplied keys/label) when one exists, else a fresh row — the login flow
    already anchors every session to a trusted_devices row, and reusing it
    keeps one physical device == one directory row for the single-device
    first slice. Per §3.3 the bootstrap loop is additionally gated by a
    successful MFA step in the full product; that binding arrives with the
    MFA integration slice, while possession of the device key is verified
    here cryptographically.

    409 if the identity already exists.
    """
    if UserCryptoIdentity.objects.filter(user=user).exists():
        raise Conflict("الهوية التشفيرية موجودة مسبقًا.")

    sign_pub = device_data["sign_pub"]
    kem_pub = device_data["kem_pub"]
    signature = device_data["sig"]
    verify_device_signature(
        identity_pub=identity_pub,
        sign_pub=sign_pub,
        kem_pub=kem_pub,
        user_id_bytes=user.id.bytes,
        signature=signature,
    )
    _ensure_sign_pub_unused(sign_pub)

    session = request_session(request)
    device = session.device if session is not None and session.device_id else None
    if device is None:
        device = TrustedDevice(user=user, device_label=device_data["label"])
    device.device_label = device_data["label"]
    device.platform = device_data["platform"]
    device.identity_sign_pub = sign_pub
    device.kem_pub = kem_pub
    device.status = "active"
    device.last_seen_at = timezone.now()
    device.save()

    identity = UserCryptoIdentity.objects.create(
        user=user,
        identity_sign_pub=identity_pub,
        bootstrap_signature=bootstrap_sig,
    )

    transparency.append_event(
        "identity_created",
        user=user,
        device=device,
        payload={
            "user_id": str(user.id),
            "identity_sign_pub_hash": transparency.hash_bytes(identity_pub),
            "algorithm": identity.algorithm,
            **_device_payload(device),
        },
    )
    return identity, device


def _ensure_sign_pub_unused(sign_pub: bytes) -> None:
    if TrustedDevice.objects.filter(identity_sign_pub=sign_pub).exists():
        raise Conflict("مفتاح توقيع الجهاز مسجّل مسبقًا.")


def _get_device_data(device_data: dict) -> dict:
    """Validate + decode the {label, platform, sign_pub, kem_pub, sig} bundle."""
    label = device_data.get("label")
    platform = device_data.get("platform", "")
    if not isinstance(label, str) or not label.strip():
        raise ValidationError({"label": "اسم الجهاز مطلوب."})
    sign_pub = b64decode_field(device_data.get("sign_pub"), "sign_pub", DEVICE_SIGN_PUB_LEN)
    kem_pub = b64decode_field(device_data.get("kem_pub"), "kem_pub", KEM_PUB_LEN)
    sig = b64decode_field(device_data.get("sig"), "sig", ED25519_SIGNATURE_LEN)
    return {
        "label": label.strip()[:255],
        "platform": str(platform)[:64],
        "sign_pub": sign_pub,
        "kem_pub": kem_pub,
        "sig": sig,
    }


def parse_device_bundle(device_data) -> dict:
    if not isinstance(device_data, dict):
        raise ValidationError({"device": "بيانات الجهاز مطلوبة."})
    return _get_device_data(device_data)


@transaction.atomic
def register_device(user, *, device_data: dict) -> TrustedDevice:
    """Register an ADDITIONAL device for a user that already has an identity.

    The device proves possession of sign_pub with the same signature scheme
    as bootstrap, this time over the EXISTING identity key. New devices are
    pending (§3.3): they appear in no directory listing and cannot upload
    KeyPackages until approved from an active session of the user.
    """
    identity = UserCryptoIdentity.objects.filter(user=user).first()
    if identity is None:
        raise Conflict("لا توجد هوية تشفيرية — يجب تشغيل bootstrap أولًا.")
    sign_pub = device_data["sign_pub"]
    kem_pub = device_data["kem_pub"]
    verify_device_signature(
        identity_pub=bytes(identity.identity_sign_pub),
        sign_pub=sign_pub,
        kem_pub=kem_pub,
        user_id_bytes=user.id.bytes,
        signature=device_data["sig"],
    )
    _ensure_sign_pub_unused(sign_pub)
    device = TrustedDevice.objects.create(
        user=user,
        device_label=device_data["label"],
        platform=device_data["platform"],
        identity_sign_pub=sign_pub,
        kem_pub=kem_pub,
        status="pending",
    )
    transparency.append_event(
        "device_added", user=user, device=device, payload=_device_payload(device)
    )
    return device


def get_own_device(user, device_id) -> TrustedDevice:
    device = TrustedDevice.objects.filter(user=user, id=device_id).first()
    if device is None:
        raise PermissionDenied("الجهاز غير موجود.")
    return device


@transaction.atomic
def approve_device(user, request, device_id: str) -> TrustedDevice:
    """Approve one of MY pending devices; the call must come from one of my
    own ACTIVE devices that carry cryptographic keys (§3.3/§3.5 — اعتماد من
    جهاز موثّق فعلًا، لا من أي جلسة دخول). Activates + transparency event."""
    device = get_own_device(user, device_id)
    session = request_session(request)
    if session is None or session.device_id is None:
        raise PermissionDenied("الاعتماد يتطلب جلسة جهاز نشطة.")
    approver = session.device
    if (
        approver is None
        or approver.status != "active"
        or approver.identity_sign_pub is None
    ):
        raise PermissionDenied("الاعتماد يجب أن يتم من جهازك الموثّق (نشط وبمفاتيح تشفير).")
    if device.status != "pending":
        raise Conflict("الجهاز ليس في حالة انتظار.")
    device.status = "active"
    device.approved_by_device = session.device
    device.approved_at = timezone.now()
    device.save(update_fields=["status", "approved_by_device", "approved_at"])
    transparency.append_event(
        "device_approved",
        user=user,
        device=device,
        payload={
            "user_id": str(user.id),
            "device_id": str(device.id),
            "approved_by_device_id": str(session.device_id) if session.device_id else None,
        },
    )
    return device


@transaction.atomic
def revoke_device(user, device_id: str) -> TrustedDevice:
    """Revoke one of my devices (§3.3): hides it from the directory and kills
    KeyPackage serving. The messaging app consumes the channel-layer
    notification to tear down the device's WebSocket."""
    device = get_own_device(user, device_id)
    if device.status == "revoked":
        return device
    device.status = "revoked"
    device.revoked_at = timezone.now()
    device.save(update_fields=["status", "revoked_at"])
    transparency.append_event(
        "device_revoked",
        user=user,
        device=device,
        payload={"user_id": str(user.id), "device_id": str(device.id)},
    )
    _notify_device_revoked(user.id, device.id)
    return device


def _notify_device_revoked(user_id, device_id) -> None:
    """Best-effort channel-layer broadcast; a no-op when channels is not
    configured (e.g. plain test runs without CHANNEL_LAYERS)."""
    try:
        from channels.layers import get_channel_layer

        layer = get_channel_layer()
        if layer is None:
            return
        from asgiref.sync import async_to_sync

        async_to_sync(layer.group_send)(
            f"user.{user_id}",
            {"type": "device_revoked", "device_id": str(device_id)},
        )
    except Exception:
        # Broadcasting must never fail the revocation itself.
        return


@transaction.atomic
def upload_keypackage(device: TrustedDevice, *, keypackage: bytes,
                      keypackage_hash: bytes, expires_at=None) -> DeviceKeyBundle:
    """Store one KeyPackage for an ACTIVE device of the caller.

    Server-side trust binding (see DeviceKeyBundle docstring): the blob is
    bound to this device row by hash uniqueness + ownership; MLS clients
    enforce the cryptographic credential binding at Welcome time. The wire
    format is never parsed here.
    """
    if device.status != "active":
        raise PermissionDenied("الجهاز ليس نشطًا — لا يمكن رفع KeyPackages.")
    if hashlib.sha256(keypackage).digest() != keypackage_hash:
        raise ValidationError({"keypackage_hash": "عدم تطابق تجزئة KeyPackage."})
    if expires_at is not None and expires_at <= timezone.now():
        raise ValidationError({"expires_at": "تاريخ انتهاء في الماضي."})
    try:
        bundle = DeviceKeyBundle.objects.create(
            device=device,
            keypackage=keypackage,
            keypackage_hash=keypackage_hash,
            expires_at=expires_at,
        )
    except IntegrityError:
        raise Conflict("KeyPackage بهذه التجزئة مسجّل مسبقًا (منع إعادة الاستخدام).")
    transparency.append_event(
        "key_uploaded",
        user=device.user,
        device=device,
        payload={
            "user_id": str(device.user_id),
            "device_id": str(device.id),
            "keypackage_hash": keypackage_hash.hex(),
        },
    )
    return bundle


def query_directory(user_ids: list) -> list[dict]:
    """Public key directory (public by design): for every requested ACTIVE
    user that has bootstrapped an identity, list their ACTIVE devices that
    carry public keys. Pending/revoked devices and keyless legacy placeholder
    rows are never exposed."""
    directory: list[dict] = []
    seen: set[str] = set()
    for raw_id in user_ids or []:
        try:
            uid = str(User._meta.pk.to_python(raw_id))
        except Exception:
            raise ValidationError({"user_ids": "معرّف مستخدم غير صالح."})
        if uid in seen:
            continue
        seen.add(uid)
        identity = (
            UserCryptoIdentity.objects.filter(user_id=uid)
            .select_related("user")
            .first()
        )
        if identity is None or not identity.user.is_active:
            continue
        devices = TrustedDevice.objects.filter(
            user_id=uid,
            status="active",
        ).exclude(
            identity_sign_pub__isnull=True,
        ).exclude(
            kem_pub__isnull=True,
        ).order_by("created_at", "id")
        directory.append(
            {
                "user_id": uid,
                "identity_pub": b64encode(identity.identity_sign_pub),
                "devices": [
                    {
                        "id": str(d.id),
                        "sign_pub": b64encode(d.identity_sign_pub),
                        "kem_pub": b64encode(d.kem_pub),
                        "status": d.status,
                    }
                    for d in devices
                ],
            }
        )
    return directory


@transaction.atomic
def claim_keypackages(device_ids: list) -> list[dict]:
    """Consume ONE unconsumed, unexpired KeyPackage per requested device
    atomically (select_for_update + consumed_at). Any authenticated user may
    claim — the directory is public — but only ACTIVE devices serve packages,
    and a device with no remaining package simply does not appear in the
    result (re-claim returns empty for that device)."""
    results: list[dict] = []
    seen: set[str] = set()
    for raw_id in device_ids or []:
        device_id = str(raw_id)
        if device_id in seen:
            continue
        seen.add(device_id)
        bundle = (
            DeviceKeyBundle.objects.filter(
                device_id=device_id,
                device__status="active",
                consumed_at__isnull=True,
            )
            .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()))
            .select_for_update()
            .order_by("uploaded_at", "id")
            .first()
        )
        if bundle is None:
            continue
        bundle.consumed_at = timezone.now()
        bundle.save(update_fields=["consumed_at"])
        results.append(
            {
                "device_id": device_id,
                "keypackage": b64encode(bundle.keypackage),
                "keypackage_hash": b64encode(bundle.keypackage_hash),
            }
        )
    return results
