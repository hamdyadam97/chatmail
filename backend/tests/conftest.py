"""Shared fixtures for the backend security suites."""
import base64
import os

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.authorization.models import Role, UserRoleAssignment
from apps.org.models import Branch, Department, EmployeeMembership, Institute

DEFAULT_PASSWORD = "Str0ng!Passw0rd"


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    """Throttle counters must not leak between tests."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def api_client():
    return APIClient()


# --- org fixtures ---------------------------------------------------------

@pytest.fixture
def institute_a(db):
    return Institute.objects.get(code="AHL")


@pytest.fixture
def institute_b(db):
    return Institute.objects.get(code="FAW")


@pytest.fixture
def branch_a(institute_a):
    return Branch.objects.create(institute=institute_a, name="فرع الرياض", code="RYD", city="الرياض")


@pytest.fixture
def branch_a2(institute_a):
    return Branch.objects.create(institute=institute_a, name="فرع جدة", code="JED", city="جدة")


@pytest.fixture
def branch_b(institute_b):
    return Branch.objects.create(institute=institute_b, name="فرع الفاو", code="FAW-B1", city="الدمام")


@pytest.fixture
def department_a(branch_a):
    return Department.objects.create(
        institute=branch_a.institute, branch=branch_a, name="قسم الموارد البشرية", code="HR"
    )


# --- user helpers ---------------------------------------------------------

def make_user(username, password=DEFAULT_PASSWORD, full_name=None, membership_unit=None,
              job_title="موظف", is_active=True):
    user = User(
        username=username,
        first_name="مستخدم",
        last_name=username,
        full_name=full_name or f"مستخدم {username}",
        must_change_password=False,
        is_active=is_active,
    )
    user.set_password(password)
    user.save()
    if membership_unit is not None:
        if isinstance(membership_unit, Department):
            EmployeeMembership.objects.create(
                user=user, institute=membership_unit.institute, branch=membership_unit.branch,
                department=membership_unit, job_title=job_title, is_primary=True,
                started_on="2024-01-01",
            )
        elif isinstance(membership_unit, Branch):
            EmployeeMembership.objects.create(
                user=user, institute=membership_unit.institute, branch=membership_unit,
                job_title=job_title, is_primary=True, started_on="2024-01-01",
            )
        elif isinstance(membership_unit, Institute):
            EmployeeMembership.objects.create(
                user=user, institute=membership_unit, job_title=job_title,
                is_primary=True, started_on="2024-01-01",
            )
    return user


def assign_role(user, role_code, institute=None, branch=None, department=None, granted_by=None):
    return UserRoleAssignment.objects.create(
        user=user,
        role=Role.objects.get(code=role_code),
        institute=institute,
        branch=branch,
        department=department,
        granted_by=granted_by,
    )


def login(client, username, password=DEFAULT_PASSWORD):
    return client.post(
        "/api/v1/auth/login/", {"username": username, "password": password}, format="json"
    )


def auth_headers(access_token):
    return {"HTTP_AUTHORIZATION": f"Bearer {access_token}"}


@pytest.fixture
def user_factory():
    return make_user


@pytest.fixture
def role_factory():
    return assign_role


# --- crypto helpers (apps.crypto_keys suites) -------------------------------

CRYPTO_BASE = "/api/v1/crypto"


def b64e(raw: bytes) -> str:
    return base64.b64encode(bytes(raw)).decode("ascii")


def new_signing_key() -> tuple[Ed25519PrivateKey, bytes]:
    """Fresh ed25519 keypair as (private_key, raw_32B_public)."""
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return priv, pub


class DeviceKeySet:
    """A generated device identity: ed25519 signing keypair + random X25519 KEM pub.

    attestation_signature() produces the proof the API requires: an ed25519
    signature over identity_pub || sign_pub || kem_pub || user.id.bytes.
    """

    def __init__(self, sign_priv: Ed25519PrivateKey, sign_pub: bytes, kem_pub: bytes):
        self.sign_priv = sign_priv
        self.sign_pub = sign_pub
        self.kem_pub = kem_pub

    def attestation_signature(self, identity_pub: bytes, user_id_bytes: bytes) -> bytes:
        return self.sign_priv.sign(identity_pub + self.sign_pub + self.kem_pub + user_id_bytes)

    def bootstrap_signature(self, identity_pub: bytes) -> bytes:
        # First device signs the identity key — closes the bootstrap loop (ERD §4.2 ب).
        return self.sign_priv.sign(identity_pub)


def make_device_keys() -> DeviceKeySet:
    sign_priv, sign_pub = new_signing_key()
    return DeviceKeySet(sign_priv=sign_priv, sign_pub=sign_pub, kem_pub=os.urandom(32))


def login_and_get_access(client, username, password=DEFAULT_PASSWORD) -> str:
    """Login via the real auth endpoint and arm the client with the token."""
    resp = login(client, username, password)
    assert resp.status_code == 200, resp.content
    access = resp.json()["access"]
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")
    return access


def bootstrap_payload(user, identity_pub: bytes, device_keys: DeviceKeySet,
                      label="test-device", platform="linux") -> dict:
    """A valid POST /crypto/identity/ body for `user`."""
    return {
        "identity_pub": b64e(identity_pub),
        "bootstrap_sig": b64e(device_keys.bootstrap_signature(identity_pub)),
        "device": {
            "label": label,
            "platform": platform,
            "sign_pub": b64e(device_keys.sign_pub),
            "kem_pub": b64e(device_keys.kem_pub),
            "sig": b64e(device_keys.attestation_signature(identity_pub, user.id.bytes)),
        },
    }


def register_device_payload(user, identity_pub: bytes, device_keys: DeviceKeySet,
                            label="phone", platform="ios") -> dict:
    """A valid POST /crypto/devices/register/ body (device attests against the
    user's EXISTING identity key)."""
    return {
        "label": label,
        "platform": platform,
        "sign_pub": b64e(device_keys.sign_pub),
        "kem_pub": b64e(device_keys.kem_pub),
        "sig": b64e(device_keys.attestation_signature(identity_pub, user.id.bytes)),
    }


@pytest.fixture
def device_keys_factory():
    return make_device_keys


@pytest.fixture
def bootstrapped_user_factory(api_client, user_factory):
    """Factory: create a user, login, run identity bootstrap.

    Returns (user, device_keys, identity_pub).
    """

    def _make(username="alice", label="test-device"):
        user = user_factory(username)
        _, identity_pub = new_signing_key()
        keys = make_device_keys()
        login_and_get_access(api_client, username)
        resp = api_client.post(
            f"{CRYPTO_BASE}/identity/", bootstrap_payload(user, identity_pub, keys, label),
            format="json",
        )
        assert resp.status_code == 201, resp.content
        return user, keys, identity_pub

    return _make
