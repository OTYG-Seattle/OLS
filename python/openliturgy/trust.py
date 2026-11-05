"""Ed25519 package and approval signatures. Mirrors ``packages/sdk/src/trust.ts``."""

from __future__ import annotations

import base64
import binascii
import re
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from .integrity import canonical_digest

PUBLIC_KEY_PATTERN = re.compile(r"^ed25519:[A-Za-z0-9_-]{43}$")
PACKAGE_SIGNATURE_CONTEXT = "OLS-PACKAGE-SIGNATURE-v1\n"
APPROVAL_SIGNATURE_CONTEXT = "OLS-APPROVAL-SIGNATURE-v1\n"
ATTESTED_STATUSES = ("parish-reviewed", "diocesan-approved", "synodal-approved")


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]*", text):
        raise ValueError("not base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _public_key_text(key: Ed25519PublicKey) -> str:
    raw = key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return "ed25519:" + _b64url_encode(raw)


def _load_private_key(private_key_pem: str) -> Ed25519PrivateKey:
    key = serialization.load_pem_private_key(private_key_pem.encode("ascii"), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise TypeError("Only Ed25519 private keys are supported.")
    return key


def generate_signing_key() -> tuple[str, str]:
    """Generate an Ed25519 key pair: ``(PKCS#8 PEM private key, "ed25519:" public key)``."""
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode("ascii")
    return pem, _public_key_text(key.public_key())


def public_key_for(private_key_pem: str) -> str:
    return _public_key_text(_load_private_key(private_key_pem).public_key())


def package_signature_message(package_digest_value: str) -> bytes:
    return (PACKAGE_SIGNATURE_CONTEXT + package_digest_value).encode("utf-8")


def approval_signature_message(approval: dict[str, Any]) -> bytes:
    signed = {key: value for key, value in approval.items() if key != "signatures"}
    return (APPROVAL_SIGNATURE_CONTEXT + canonical_digest(signed)).encode("utf-8")


def sign_message(message: bytes, private_key_pem: str) -> dict[str, str]:
    key = _load_private_key(private_key_pem)
    return {"key": _public_key_text(key.public_key()), "signature": _b64url_encode(key.sign(message))}


def verify_signature(message: bytes, entry: Any) -> bool:
    """True when ``entry["signature"]`` is a valid Ed25519 signature of ``message`` by ``entry["key"]``."""
    if not isinstance(entry, dict):
        return False
    key, signature = entry.get("key"), entry.get("signature")
    if not isinstance(key, str) or not PUBLIC_KEY_PATTERN.match(key) or not isinstance(signature, str):
        return False
    try:
        raw_signature = _b64url_decode(signature)
        if len(raw_signature) != 64:
            return False
        Ed25519PublicKey.from_public_bytes(_b64url_decode(key[len("ed25519:") :])).verify(raw_signature, message)
        return True
    except (InvalidSignature, ValueError, binascii.Error):
        return False


def trusted_key(keyring: dict[str, Any] | None, key: str) -> dict[str, Any] | None:
    """The keyring entry for a key, if the consumer trusts it."""
    if not isinstance(keyring, dict):
        return None
    return next((entry for entry in keyring.get("keys", []) if isinstance(entry, dict) and entry.get("key") == key), None)
