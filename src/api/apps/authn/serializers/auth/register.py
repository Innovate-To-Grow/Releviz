"""
Registration serializer for user signup.
"""

from __future__ import annotations

import re

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError
from rest_framework import serializers

from apps.authn.models.security import EmailAuthChallenge
from apps.authn.services import (
    claim_unclaimed_contact_email,
    get_pending_registration_member,
    issue_email_challenge,
    normalize_email,
    registration_email_conflicts,
)

from ..helpers import decrypt_password_pair

Member = get_user_model()

_HTML_TAG_RE = re.compile(r"<[^>]+>")


class RegisterSerializer(serializers.Serializer):
    """
    Serializer for user registration.
    Requires email, password, first name, and last name.
    Passwords should be RSA encrypted with the public key.
    """

    email = serializers.EmailField(
        required=True,
        help_text="Email address for registration.",
    )
    password = serializers.CharField(
        write_only=True,
        required=True,
        help_text="RSA encrypted password (base64 encoded).",
    )
    password_confirm = serializers.CharField(
        write_only=True,
        required=True,
        help_text="RSA encrypted password confirmation (base64 encoded).",
    )
    key_id = serializers.CharField(
        required=False,
        allow_blank=True,
        help_text="Key ID used for encryption (for key rotation handling).",
    )
    first_name = serializers.CharField(
        required=True,
        max_length=150,
        help_text="User's first name.",
    )
    last_name = serializers.CharField(
        required=True,
        max_length=150,
        help_text="User's last name.",
    )

    # noinspection PyMethodMayBeStatic
    def validate_first_name(self, value: str) -> str:
        if _HTML_TAG_RE.search(value):
            raise serializers.ValidationError("First name must not contain HTML tags.")
        return value

    # noinspection PyMethodMayBeStatic
    def validate_last_name(self, value: str) -> str:
        if _HTML_TAG_RE.search(value):
            raise serializers.ValidationError("Last name must not contain HTML tags.")
        return value

    # noinspection PyAttributeOutsideInit
    def validate_email(self, value: str) -> str:
        email_lower = normalize_email(value)
        pending_member = get_pending_registration_member(email_lower)
        if registration_email_conflicts(
            email_lower,
            exclude_member_id=pending_member.pk if pending_member else None,
            allow_unclaimed=True,
        ):
            raise serializers.ValidationError("Unable to register with this email address.")
        self._pending_member = pending_member
        return email_lower

    # noinspection PyMethodMayBeStatic
    def validate(self, attrs: dict) -> dict:
        candidate = Member(
            first_name=attrs.get("first_name", ""),
            last_name=attrs.get("last_name", ""),
        )
        attrs["_decrypted_password"] = decrypt_password_pair(
            attrs,
            password_key="password",
            confirm_key="password_confirm",
            user=candidate,
        )
        return attrs

    def create(self, validated_data: dict) -> Member:
        """
        Create a new user with the validated data.
        User is created or updated as inactive until email is verified.
        """
        email = validated_data["email"]
        password = validated_data["_decrypted_password"]

        first_name = validated_data.get("first_name", "")
        last_name = validated_data.get("last_name", "")
        candidate = Member(
            first_name=first_name,
            last_name=last_name,
        )
        try:
            validate_password(password, user=candidate)
        except DjangoValidationError as exc:
            raise serializers.ValidationError({"password": list(exc.messages)}) from exc

        from apps.authn.models import ContactEmail

        member = getattr(self, "_pending_member", None)
        if member is None:
            member = Member.objects.create_user(
                password=password,
                first_name=first_name,
                last_name=last_name,
                is_active=False,
            )
            if claim_unclaimed_contact_email(email, member=member) is None:
                pending_member = get_pending_registration_member(email)
                if pending_member is not None:
                    member.delete()
                    member = pending_member
                else:
                    try:
                        ContactEmail.objects.create(
                            member=member,
                            email_address=email,
                            email_type="primary",
                            verified=False,
                        )
                    except IntegrityError as exc:
                        pending_member = get_pending_registration_member(email)
                        member.delete()
                        if pending_member is None:
                            raise serializers.ValidationError(
                                {"email": "Unable to register with this email address."}
                            ) from exc
                        member = pending_member

        member.first_name = first_name
        member.last_name = last_name
        member.is_active = False
        member.set_password(password)

        update_fields = ["first_name", "last_name", "is_active", "password", "updated_at"]
        member.save(update_fields=update_fields)

        issue_email_challenge(
            member=member,
            purpose=EmailAuthChallenge.Purpose.REGISTER,
            target_email=email,
            link_flow="register",
            link_source="register",
        )

        return member
