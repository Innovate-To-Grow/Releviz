"""Shared helpers for authn serializers."""

from __future__ import annotations

from django.conf import settings
from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers

from apps.authn.constants import ENCRYPTED_FIELD_DECRYPT_FAILED
from apps.authn.services import RSADecryptionError, decrypt_password, is_encrypted_password


def decrypt_field(value: str, key_id: str | None = None) -> str:
    """Decrypt an RSA-encrypted field value.

    Returns the plaintext if the value appears encrypted, or the original value
    if plaintext passwords are allowed (dev/test). Raises ``ValidationError`` on
    decryption failure or when production requires encrypted values.
    """
    if is_encrypted_password(value):
        try:
            return decrypt_password(value, key_id or None)
        except RSADecryptionError as exc:
            raise serializers.ValidationError(ENCRYPTED_FIELD_DECRYPT_FAILED) from exc
    if getattr(settings, "REQUIRE_ENCRYPTED_PASSWORDS", False):
        raise serializers.ValidationError("Encrypted password required.")
    return value


def decrypt_password_pair(
    attrs: dict,
    *,
    password_key: str = "new_password",
    confirm_key: str = "new_password_confirm",
    user=None,
) -> str:
    """Decrypt, validate, and confirm a pair of password fields.

    Returns the plaintext new password. Mutates nothing in *attrs*.
    """
    key_id = attrs.get("key_id", "")
    try:
        new_password = decrypt_field(attrs[password_key], key_id)
    except serializers.ValidationError as exc:
        raise serializers.ValidationError({password_key: exc.detail}) from exc

    try:
        confirm_password = decrypt_field(attrs[confirm_key], key_id)
    except serializers.ValidationError as exc:
        raise serializers.ValidationError({confirm_key: exc.detail}) from exc

    if len(new_password) < 8:
        raise serializers.ValidationError({password_key: "Password must be at least 8 characters."})

    try:
        validate_password(new_password, user=user)
    except Exception as exc:  # noqa: BLE001
        raise serializers.ValidationError({password_key: list(exc.messages)}) from exc

    if new_password != confirm_password:
        raise serializers.ValidationError({confirm_key: "Passwords do not match."})

    return new_password
