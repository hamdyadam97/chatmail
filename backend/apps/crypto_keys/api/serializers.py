"""Request serializers for the crypto_keys API.

These validate shape/presence only; byte-level decoding, signature
verification and state rules live in apps.crypto_keys.services.
"""
from rest_framework import serializers


class DeviceBundleSerializer(serializers.Serializer):
    label = serializers.CharField(max_length=255)
    platform = serializers.CharField(max_length=64, required=False, allow_blank=True, default="")
    sign_pub = serializers.CharField()  # base64, 32B ed25519
    kem_pub = serializers.CharField()  # base64, 32B x25519
    sig = serializers.CharField()  # base64, 64B ed25519 signature


class IdentityBootstrapSerializer(serializers.Serializer):
    identity_pub = serializers.CharField()  # base64, 32B ed25519 identity key
    bootstrap_sig = serializers.CharField()  # base64, 64B
    device = DeviceBundleSerializer()


class KeyUploadSerializer(serializers.Serializer):
    keypackage = serializers.CharField()  # base64 opaque MLS wire blob
    keypackage_hash = serializers.CharField()  # base64 sha256 of the blob
    expires_at = serializers.DateTimeField(required=False)
    device_id = serializers.UUIDField(required=False)  # جهازي النشط المحدد (اختياري)


class KeyQuerySerializer(serializers.Serializer):
    user_ids = serializers.ListField(
        child=serializers.CharField(), min_length=1, max_length=200
    )


class KeyClaimSerializer(serializers.Serializer):
    device_ids = serializers.ListField(
        child=serializers.CharField(), min_length=1, max_length=200
    )
