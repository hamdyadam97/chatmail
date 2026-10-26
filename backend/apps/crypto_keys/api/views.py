"""REST API for the crypto_keys app — mounted by the integrator at
path("api/v1/crypto/", include("apps.crypto_keys.api.urls")).

Contract (frontend depends on this):
  POST identity/                     -> 201 {user_id, identity_pub, algorithm,
                                          device_id, device_status}
  GET  devices/                      -> [ {id, label, platform, status,
                                          created_at, last_seen_at} ]
  POST devices/                      -> 201 {id, label, platform, status,
                                          created_at}  (status=pending)
  POST devices/{id}/approve/         -> 200 {id, status}   (pending -> active)
       {approver_device_id, issued_at, signature}  (approver's device signature)
  POST devices/{id}/revoke/          -> 200 {id, status}   (-> revoked)
  POST keys/upload/                  -> 201 {id, device_id, keypackage_hash,
                                          uploaded_at, expires_at}
  POST keys/query/  {user_ids}       -> [ {user_id, identity_pub,
                                          devices:[{id, sign_pub, kem_pub,
                                          status}]} ]
  POST keys/claim/  {device_ids}     -> [ {device_id, keypackage,
                                          keypackage_hash} ]
  GET  transparency/self/            -> [ {seq, event_type, prev_hash,
                                          entry_hash, payload, log_signature,
                                          created_at} ]  (ordered, hash-linked)
  GET  transparency/log-key/         -> {log_pub}

All endpoints require authentication. State changes append a signed
key-transparency event transactionally and are audit-logged (identifiers
only).
"""
from django.conf import settings
from django.http import HttpResponse
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import BaseParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.status import HTTP_201_CREATED
from rest_framework.views import APIView

from apps.notifications.services import notify
from apps.accounts.models import TrustedDevice
from apps.audit.services import log, primary_org_scope, request_context

from .. import services, transparency
from ..models import DeviceKeyBundle, KeyTransparencyEvent
from .serializers import (
    DeviceBundleSerializer,
    IdentityBootstrapSerializer,
    KeyClaimSerializer,
    KeyQuerySerializer,
    KeyUploadSerializer,
)
from ..throttles import KeyBackupThrottle, KeyClaimThrottle, KeyQueryThrottle, KeyUploadThrottle


def _audit(request, action, *, target_type="", target_id=None, metadata=None):
    log(
        actor=request.user,
        action=action,
        target_type=target_type,
        target_id=target_id,
        org_scope=primary_org_scope(request.user),
        **request_context(request),
        metadata=metadata or {},
    )


class IdentityBootstrapView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = IdentityBootstrapSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        identity_pub = services.b64decode_field(
            serializer.validated_data["identity_pub"], "identity_pub",
            services.IDENTITY_SIGN_PUB_LEN,
        )
        bootstrap_sig = services.b64decode_field(
            serializer.validated_data["bootstrap_sig"], "bootstrap_sig",
            services.ED25519_SIGNATURE_LEN,
        )
        device_data = services.parse_device_bundle(serializer.validated_data["device"])

        identity, device = services.bootstrap_identity(
            request.user,
            request,
            identity_pub=identity_pub,
            bootstrap_sig=bootstrap_sig,
            device_data=device_data,
        )
        _audit(
            request,
            "key_event",
            target_type="user_crypto_identity",
            target_id=identity.user_id,
            metadata={"kind": "identity_created", "device_id": str(device.id)},
        )
        return Response(
            {
                "user_id": str(identity.user_id),
                "identity_pub": services.b64encode(identity.identity_sign_pub),
                "algorithm": identity.algorithm,
                "device_id": str(device.id),
                "device_status": device.status,
            },
            status=HTTP_201_CREATED,
        )


class DeviceListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        devices = request.user.trusted_devices.order_by("created_at", "id")
        return Response(
            [
                {
                    "id": str(d.id),
                    "label": d.device_label,
                    "platform": d.platform,
                    "status": d.status,
                    "created_at": d.created_at,
                    "last_seen_at": d.last_seen_at,
                }
                for d in devices
            ]
        )


class DeviceRegisterView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = DeviceBundleSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        device_data = services.parse_device_bundle(serializer.validated_data)
        device = services.register_device(request.user, device_data=device_data)
        notify([request.user.id], "device_alert", ref_type="trusted_device", ref_id=device.id)
        _audit(
            request,
            "device_added",
            target_type="trusted_device",
            target_id=device.id,
            metadata={"device_id": str(device.id), "status": device.status},
        )
        return Response(
            {
                "id": str(device.id),
                "label": device.device_label,
                "platform": device.platform,
                "status": device.status,
                "created_at": device.created_at,
            },
            status=HTTP_201_CREATED,
        )


class DeviceApproveView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, device_id):
        proof = request.data if isinstance(request.data, dict) else None
        device = services.approve_device(request.user, request, device_id, proof)
        notify([request.user.id], "device_alert", ref_type="trusted_device", ref_id=device.id)
        _audit(
            request,
            "device_approved",
            target_type="trusted_device",
            target_id=device.id,
            metadata={
                "device_id": str(device.id),
                "approved_by_device_id": str(device.approved_by_device_id)
                if device.approved_by_device_id
                else None,
            },
        )
        return Response({"id": str(device.id), "status": device.status})


class DeviceRevokeView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, device_id):
        device = services.revoke_device(request.user, device_id)
        notify([request.user.id], "device_alert", ref_type="trusted_device", ref_id=device.id)
        _audit(
            request,
            "device_revoked",
            target_type="trusted_device",
            target_id=device.id,
            metadata={"device_id": str(device.id)},
        )
        return Response({"id": str(device.id), "status": device.status})


class KeyUploadView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [KeyUploadThrottle]

    def post(self, request):
        serializer = KeyUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        keypackage = services.b64decode_field(
            serializer.validated_data["keypackage"], "keypackage"
        )
        keypackage_hash = services.b64decode_field(
            serializer.validated_data["keypackage_hash"], "keypackage_hash", 32
        )

        session = services.request_session(request)
        if session is None or session.device_id is None:
            raise PermissionDenied("لا توجد جلسة جهاز نشطة.")
        # device_id اختياري: جهازي النشط المحدد (لرفع KP لجهاز محدد ضمن
        # أجهزتي) — افتراضيًا جهاز الجلسة الحالية.
        explicit_device_id = serializer.validated_data.get("device_id")
        if explicit_device_id:
            device = (
                TrustedDevice.objects.filter(id=explicit_device_id, user=request.user).first()
            )
            if device is None:
                raise PermissionDenied("الجهاز غير موجود أو لا يخصك.")
        else:
            device = session.device
        bundle = services.upload_keypackage(
            device,
            keypackage=keypackage,
            keypackage_hash=keypackage_hash,
            expires_at=serializer.validated_data.get("expires_at"),
        )
        _audit(
            request,
            "key_event",
            target_type="device_key_bundle",
            target_id=bundle.id,
            metadata={
                "kind": "key_uploaded",
                "device_id": str(bundle.device_id),
                "keypackage_hash": bundle.keypackage_hash.hex(),
            },
        )
        return Response(
            {
                "id": str(bundle.id),
                "device_id": str(bundle.device_id),
                "keypackage_hash": services.b64encode(bundle.keypackage_hash),
                "uploaded_at": bundle.uploaded_at,
                "expires_at": bundle.expires_at,
            },
            status=HTTP_201_CREATED,
        )


class KeyQueryView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [KeyQueryThrottle]

    def post(self, request):
        serializer = KeyQuerySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response({"users": services.query_directory(serializer.validated_data["user_ids"])})


class KeyClaimView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [KeyClaimThrottle]

    def post(self, request):
        serializer = KeyClaimSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(services.claim_keypackages(serializer.validated_data["device_ids"]))


class TransparencySelfView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        events = (
            KeyTransparencyEvent.objects.filter(user=request.user)
            .order_by("id")
            .iterator()
        )
        return Response(
            [
                {
                    "seq": e.id,
                    "event_type": e.event_type,
                    "prev_hash": services.b64encode(e.prev_hash),
                    "entry_hash": services.b64encode(e.entry_hash),
                    "payload": e.payload,
                    "log_signature": services.b64encode(e.log_signature),
                    "created_at": e.created_at,
                }
                for e in events
            ]
        )


class TransparencyLogKeyView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({"log_pub": transparency.log_public_key_b64()})


class KeyCountView(APIView):
    """GET keys/count/[?device_id=] — unconsumed, unexpired KeyPackages of one
    of MY devices (default: this session's device). Lets the client top the
    pool up only when needed instead of uploading on every page load."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        device_id = request.query_params.get("device_id")
        if device_id:
            device = TrustedDevice.objects.filter(id=device_id, user=request.user).first()
        else:
            session = services.request_session(request)
            device = session.device if session is not None else None
        if device is None:
            raise PermissionDenied("الجهاز غير موجود أو لا يخصك.")
        available = (
            DeviceKeyBundle.objects.filter(device=device, consumed_at__isnull=True)
            .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()))
            .count()
        )
        return Response({"device_id": str(device.id), "available": available})


# --- Encrypted recovery backups ---------------------------------------------------

class _BackupParser(BaseParser):
    """Raw ciphertext; size bounded before reading."""

    media_type = "application/octet-stream"

    def parse(self, stream, media_type=None, parser_context=None):
        limit = settings.KEY_BACKUP_MAX_BYTES
        try:
            declared = int(parser_context["request"].META.get("CONTENT_LENGTH") or 0)
        except ValueError:
            declared = 0
        if declared > limit:
            raise ValidationError({"backup": "النسخة أكبر من المسموح."})
        data = stream.read(limit + 1) if stream is not None else b""
        if len(data) > limit:
            raise ValidationError({"backup": "النسخة أكبر من المسموح."})
        return data


class KeyBackupListCreateView(APIView):
    """GET my backups (metadata only) · POST a new encrypted bundle.

    POST body = ciphertext (application/octet-stream); headers carry
    X-Backup-Device, X-Backup-Key-Id, X-Backup-IV (base64) and
    X-Backup-Signature (base64 Ed25519 by that device's key)."""

    permission_classes = [IsAuthenticated]
    parser_classes = [_BackupParser]

    def get_throttles(self):
        return [KeyBackupThrottle()] if self.request.method == "POST" else []

    def get(self, request):
        return Response([services.backup_to_dict(b) for b in services.list_backups(request.user)])

    def post(self, request):
        data = request.data
        if not isinstance(data, (bytes, bytearray)):
            raise ValidationError({"backup": "أرسل النسخة كـ application/octet-stream."})
        headers = request.headers
        backup = services.store_backup(
            request.user,
            device_id=headers.get("X-Backup-Device", ""),
            key_id=headers.get("X-Backup-Key-Id", ""),
            iv=services.b64decode_field(headers.get("X-Backup-IV"), "iv", 12),
            ciphertext=bytes(data),
            signature=services.b64decode_field(
                headers.get("X-Backup-Signature"), "signature", services.ED25519_SIGNATURE_LEN
            ),
        )
        _audit(
            request,
            "key_backup_uploaded",
            target_type="trusted_device",
            target_id=backup.device_id,
            metadata={"version": backup.version, "size": backup.ciphertext_size},
        )
        return Response(services.backup_to_dict(backup), status=HTTP_201_CREATED)


class KeyBackupDownloadView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, backup_id):
        backup = services.get_own_backup(request.user, backup_id)
        _audit(request, "key_backup_downloaded", target_type="trusted_device", target_id=backup.device_id,
               metadata={"version": backup.version})
        response = HttpResponse(bytes(backup.ciphertext), content_type="application/octet-stream")
        response["Cache-Control"] = "no-store"
        response["X-Content-Type-Options"] = "nosniff"
        return response


class KeyBackupRestoredView(APIView):
    """The browser opened a backup and took over its device (see services.complete_restore)."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        body = request.data if isinstance(request.data, dict) else {}
        device, abandoned = services.complete_restore(
            request.user,
            request,
            device_id=body.get("device_id"),
            backup_id=body.get("backup_id"),
            abandoned_device_id=body.get("abandoned_device_id") or None,
            issued_at=body.get("issued_at"),
            signature=services.b64decode_field(body.get("signature"), "signature", services.ED25519_SIGNATURE_LEN),
        )
        notify([request.user.id], "device_alert", ref_type="trusted_device", ref_id=device.id)
        _audit(
            request,
            "device_restored",
            target_type="trusted_device",
            target_id=device.id,
            metadata={"abandoned_device_id": str(abandoned.id) if abandoned else None},
        )
        return Response({"device_id": str(device.id), "status": device.status})
