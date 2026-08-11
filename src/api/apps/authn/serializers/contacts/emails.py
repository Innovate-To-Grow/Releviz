"""
Serializers for contact email management.
"""

import re

from rest_framework import serializers


class ContactEmailSerializer(serializers.Serializer):
    """Read-only serializer for contact email list/detail responses."""

    id = serializers.UUIDField(read_only=True)
    email_address = serializers.EmailField(read_only=True)
    email_type = serializers.CharField(read_only=True)
    subscribe = serializers.BooleanField(read_only=True)
    verified = serializers.BooleanField(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)


class ContactEmailCreateSerializer(serializers.Serializer):
    """Serializer for creating a new contact email."""

    email_address = serializers.EmailField(required=True)
    email_type = serializers.ChoiceField(
        choices=[("secondary", "Secondary"), ("other", "Other")],
        default="secondary",
    )
    subscribe = serializers.BooleanField(default=True)

    # noinspection PyMethodMayBeStatic
    def validate_email_type(self, value):
        if value == "primary":
            raise serializers.ValidationError("Cannot create a contact email with type 'primary'.")
        return value


class ContactEmailUpdateSerializer(serializers.Serializer):
    """Serializer for updating a contact email (type and subscribe only)."""

    email_type = serializers.ChoiceField(
        choices=[("secondary", "Secondary"), ("other", "Other")],
        required=False,
    )
    subscribe = serializers.BooleanField(required=False)

    # noinspection PyMethodMayBeStatic
    def validate_email_type(self, value):
        if value == "primary":
            raise serializers.ValidationError("Cannot set contact email type to 'primary'.")
        return value


class ContactEmailVerifyCodeSerializer(serializers.Serializer):
    """Serializer for verifying a contact email with a 6-digit code."""

    code = serializers.CharField(required=True, min_length=6, max_length=6)

    # noinspection PyMethodMayBeStatic
    def validate_code(self, value):
        if not re.match(r"^\d{6}$", value):
            raise serializers.ValidationError("Code must be exactly 6 digits.")
        return value
