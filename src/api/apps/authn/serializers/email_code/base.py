"""Shared serializer building blocks for email-code flows."""

from __future__ import annotations

import re

from rest_framework import serializers

from apps.authn.constants import VERIFICATION_INVALID
from apps.authn.models.security import EmailAuthChallenge
from apps.authn.services import AuthChallengeInvalid, normalize_email, verify_email_code

_CODE_RE = re.compile(r"^\d{6}$")


class BaseEmailSerializer(serializers.Serializer):
    email = serializers.EmailField(required=True)

    def validate_email(self, value: str) -> str:
        return normalize_email(value)


class BaseCodeVerifySerializer(BaseEmailSerializer):
    code = serializers.CharField(required=True, max_length=6, min_length=6)

    purpose: str = ""

    def validate_code(self, value: str) -> str:
        normalized = value.strip()
        if not _CODE_RE.match(normalized):
            raise serializers.ValidationError("Code must be a 6-digit number.")
        return normalized

    def validate(self, attrs: dict) -> dict:
        attrs = super().validate(attrs)
        approved_callback = self.context.get("approved_callback")
        try:
            result = verify_email_code(
                purpose=self.purpose,
                target_email=attrs["email"],
                code=attrs["code"],
                approved_callback=approved_callback,
            )
        except AuthChallengeInvalid as exc:
            raise serializers.ValidationError({"detail": VERIFICATION_INVALID}) from exc

        if approved_callback is not None:
            attrs["approved_result"] = result
        else:
            attrs["challenge"] = result
            attrs["member"] = result.member
        return attrs


PURPOSE = EmailAuthChallenge.Purpose
