"""
Symmetric encryption for RSA private keys at rest.

Uses Fernet (AES-128-CBC + HMAC-SHA256) with a key derived from DJANGO_SECRET_KEY.
"""

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings

_ENCRYPTED_PREFIX = "fernet:"


def _get_fernet() -> Fernet:
    key = hashlib.sha256(settings.SECRET_KEY.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_pem(pem_text: str) -> str:
    """Encrypt a PEM string and return a prefixed ciphertext."""
    return _ENCRYPTED_PREFIX + _get_fernet().encrypt(pem_text.encode()).decode()


def decrypt_pem(stored_text: str) -> str:
    """Decrypt a stored PEM value. Handles both encrypted (prefixed) and legacy plaintext."""
    if stored_text.startswith(_ENCRYPTED_PREFIX):
        try:
            return _get_fernet().decrypt(stored_text[len(_ENCRYPTED_PREFIX) :].encode()).decode()
        except InvalidToken as exc:
            raise ValueError("Failed to decrypt private key. Has SECRET_KEY changed?") from exc
    # Legacy plaintext — return as-is (will be encrypted on next save)
    return stored_text


def is_encrypted(stored_text: str) -> bool:
    """Check whether a stored value is already Fernet-encrypted."""
    return stored_text.startswith(_ENCRYPTED_PREFIX)
