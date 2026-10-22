"""Helpers for the approvals suites: devices with REAL Ed25519 keys and
correctly signed decision payloads (same format as the web client)."""
import base64
import json
from datetime import datetime, timezone as dt_timezone

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from apps.accounts.models import TrustedDevice
from apps.approvals.services import SIGNING_CONTEXT

APPROVALS_URL = "/api/v1/approvals/"


def signing_device(user, label="signer"):
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    device = TrustedDevice.objects.create(
        user=user, device_label=label, platform="test", status="active", identity_sign_pub=pub
    )
    return device, priv


def canonical(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def now_iso() -> str:
    return datetime.now(dt_timezone.utc).isoformat()


def build_payload(req: dict, user, device, decision="approved", on_behalf_of=None, **override) -> dict:
    payload = {
        "approver_id": str(user.id),
        "content_hash": req["content_hash"],
        "correspondence_id": req["correspondence"]["id"],
        "decided_at": now_iso(),
        "decision": decision,
        "device_id": str(device.id),
        "on_behalf_of": str(getattr(on_behalf_of, "id", on_behalf_of)) if on_behalf_of else None,
        "request_id": req["id"],
        "step_order": req["current_step_order"],
    }
    payload.update(override)
    return payload


def decide(client, headers, req: dict, user, signer, decision="approved", on_behalf_of=None,
           raw_payload: bytes | None = None, sign_with=None, **override):
    device, priv = signer
    payload = raw_payload if raw_payload is not None else canonical(
        build_payload(req, user, device, decision, on_behalf_of, **override)
    )
    signature = (sign_with or priv).sign(SIGNING_CONTEXT + payload)
    body = {
        "payload": base64.b64encode(payload).decode(),
        "signature": base64.b64encode(signature).decode(),
        "device_id": str(device.id),
    }
    return client.post(f"{APPROVALS_URL}{req['id']}/decide/", body, format="json", **headers)


def request_approval(client, headers, correspondence_id, steps):
    body = {
        "correspondence_id": str(correspondence_id),
        "steps": [{"type": t, "approver_ids": [str(u.id) for u in users]} for t, users in steps],
    }
    return client.post(APPROVALS_URL, body, format="json", **headers)
