"""Serializers for passwordless phone-auth flows (request code + verify code).

The OTP itself is consumed in the view (``check_phone_verification``) rather than
in ``validate()`` so the one-time consume and the resolve-or-create stay together
and map cleanly to HTTP status codes.
"""

from __future__ import annotations

import re

from rest_framework import serializers

from apps.authn.models.contact.phone_regions import PHONE_REGION_CHOICES
from apps.authn.services import request_phone_auth

from ..contacts.phones import (
    normalize_and_validate_us_phone,
    validate_us_region,
)

_CODE_RE = re.compile(r"^\d{6}$")

PHONE_AUTH_SOURCE_CHOICES = (
    ("login", "login"),
    ("subscribe", "subscribe"),
    ("event_registration", "event_registration"),
)


class BasePhoneAuthSerializer(serializers.Serializer):
    phone_number = serializers.CharField(required=True)
    region = serializers.ChoiceField(choices=PHONE_REGION_CHOICES, required=False, default="1-US")

    # noinspection PyMethodMayBeStatic
    def validate_phone_number(self, value: str) -> str:
        return normalize_and_validate_us_phone(value)

    # noinspection PyMethodMayBeStatic
    def validate_region(self, value: str) -> str:
        return validate_us_region(value)


class UnifiedPhoneAuthRequestSerializer(BasePhoneAuthSerializer):
    """Request an SMS verification code for passwordless signup/login."""

    # `source` mirrors the email request serializer for API parity and lets the
    # client declare the entry point (login / subscribe / event_registration).
    # The phone request flow does not yet branch on it, so it is validated (an
    # unknown source is a 400) but not consumed.
    source = serializers.ChoiceField(choices=PHONE_AUTH_SOURCE_CHOICES, required=False, default="login")

    def save(self):
        return request_phone_auth(self.validated_data["phone_number"], self.validated_data["region"])


class UnifiedPhoneAuthVerifySerializer(BasePhoneAuthSerializer):
    """Verify an SMS code using a challenge ID or the legacy phone lookup."""

    phone_number = serializers.CharField(required=False)
    challenge_id = serializers.UUIDField(required=False)
    code = serializers.CharField(required=True, min_length=6, max_length=6)

    # noinspection PyMethodMayBeStatic
    def validate_code(self, value: str) -> str:
        normalized = value.strip()
        if not _CODE_RE.match(normalized):
            raise serializers.ValidationError("Code must be a 6-digit number.")
        return normalized

    def validate(self, attrs):
        if not attrs.get("challenge_id") and not attrs.get("phone_number"):
            raise serializers.ValidationError(
                {"challenge_id": "Provide challenge_id (preferred) or phone_number for legacy verification."}
            )
        return attrs
