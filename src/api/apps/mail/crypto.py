import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings


def _fernet() -> Fernet:
    key_material = getattr(settings, "FIELD_ENCRYPTION_KEY", "") or settings.SECRET_KEY
    try:
        key_material.encode("ascii")
        return Fernet(key_material)
    except Exception:  # noqa: BLE001
        digest = hashlib.sha256(key_material.encode("utf-8")).digest()
        return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str) -> str:
    if not value:
        return ""
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(value: str) -> str:
    if not value:
        return ""
    try:
        return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
    except InvalidToken:
        return ""
