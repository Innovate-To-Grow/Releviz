"""
Serializers for contact phone management.
"""

import re

from rest_framework import serializers

from apps.authn.models.contact.phone_regions import PHONE_REGION_CHOICES

_VALID_REGION_CODES = {code for code, _ in PHONE_REGION_CHOICES}


def normalize_and_validate_us_phone(value: str) -> str:
    """Strip formatting, drop an optional ``+1`` country code, and require exactly
    10 US national digits.

    Returns the cleaned value; E.164 normalization happens in the service layer.
    Shared by the contact-phone and passwordless phone-auth serializers.
    """
    cleaned = re.sub(r"[\s()\-.]", "", value.strip())
    if not cleaned:
        raise serializers.ValidationError("Phone number is required.")

    digits = cleaned[1:] if cleaned.startswith("+") else cleaned
    if not digits.isdigit():
        raise serializers.ValidationError("Phone number must contain only digits (and an optional leading +).")

    # US-only: drop an optional leading country code "1", then require exactly 10 national digits.
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        raise serializers.ValidationError("US phone numbers must be exactly 10 digits.")

    return cleaned


def validate_us_region(value: str) -> str:
    """Validate a phone region against the supported (US-only) choices."""
    if value not in _VALID_REGION_CODES:
        raise serializers.ValidationError("Invalid region.")
    return value


class ContactPhoneSerializer(serializers.Serializer):
    """Read-only serializer for contact phone list/detail responses."""

    id = serializers.UUIDField(read_only=True)
    phone_number = serializers.CharField(read_only=True)
    region = serializers.CharField(read_only=True)
    region_display = serializers.SerializerMethodField()
    subscribe = serializers.BooleanField(read_only=True)
    verified = serializers.BooleanField(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)

    # noinspection PyMethodMayBeStatic
    def get_region_display(self, obj) -> str:
        return obj.get_region_display_name()


class ContactPhoneCreateSerializer(serializers.Serializer):
    """Serializer for creating a new contact phone."""

    phone_number = serializers.CharField(required=True)
    region = serializers.ChoiceField(choices=PHONE_REGION_CHOICES, required=False, default="1-US")
    subscribe = serializers.BooleanField(default=False)

    # noinspection PyMethodMayBeStatic
    def validate_phone_number(self, value):
        return normalize_and_validate_us_phone(value)

    # noinspection PyMethodMayBeStatic
    def validate_region(self, value):
        return validate_us_region(value)


class ContactPhoneUpdateSerializer(serializers.Serializer):
    """Serializer for updating a contact phone (subscribe only)."""

    subscribe = serializers.BooleanField(required=True)


class ContactPhoneVerifyCodeSerializer(serializers.Serializer):
    """Serializer for verifying a contact phone with a 6-digit code."""

    code = serializers.CharField(required=True, min_length=6, max_length=6)
    challenge_id = serializers.UUIDField(required=False)

    # noinspection PyMethodMayBeStatic
    def validate_code(self, value):
        cleaned = value.strip()
        if not re.match(r"^\d{6}$", cleaned):
            raise serializers.ValidationError("Code must be exactly 6 digits.")
        return cleaned
