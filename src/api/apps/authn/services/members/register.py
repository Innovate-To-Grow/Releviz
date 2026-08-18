"""Member registration and temporary-account upgrade service."""

import logging
import uuid

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from rest_framework import serializers

from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.authn.services.email.auth_email import normalize_email
from apps.authn.services.email.challenges import AuthChallengeDeliveryError, issue_email_challenge
from apps.authn.services.security.rsa_manager import decrypt_password

logger = logging.getLogger(__name__)

TEMP_MAILBOX_REGISTRATION_SCOPE = "temporary-mailbox-registration"
TEMP_SESSION_REGISTRATION_SCOPE = "temporary-session-registration"


def validate_password_pair(data: dict, *, password_key: str = "password") -> str:
    password = decrypt_password(data.get(password_key, ""), data.get("key_id", ""))
    confirm_raw = data.get(f"{password_key}_confirm", data.get("password_confirm", password))
    confirm = decrypt_password(confirm_raw, data.get("key_id", ""))
    if password != confirm:
        raise serializers.ValidationError({"password_confirm": "Passwords do not match."})
    if len(password) < 8:
        raise serializers.ValidationError({"password": "Password must be at least 8 characters."})
    return password


def _validated_registration_details(data: dict) -> dict:
    password = validate_password_pair(data)
    first_name = str(data.get("first_name") or data.get("firstName") or "").strip()
    last_name = str(data.get("last_name") or data.get("lastName") or "").strip()
    if not first_name:
        raise serializers.ValidationError({"first_name": "First name is required."})
    if not last_name:
        raise serializers.ValidationError({"last_name": "Last name is required."})
    return {
        "password": password,
        "first_name": first_name,
        "last_name": last_name,
    }


def _apply_registration_details(member, details: dict, *, email: str) -> None:
    member.first_name = details["first_name"]
    member.last_name = details["last_name"]
    member.email = email
    try:
        validate_password(details["password"], user=member)
    except DjangoValidationError as exc:
        raise serializers.ValidationError({"password": list(exc.messages)}) from exc
    member.set_password(details["password"])


@transaction.atomic
def start_registration(data: dict, *, _temporary_upgrade_member_id=None):
    """Start a member registration, issuing an email verification challenge.

    ``_temporary_upgrade_member_id`` is a private capability supplied only
    after an event-scoped temporary session has been authenticated.
    """
    email = normalize_email(data.get("email", ""))
    if not email:
        raise serializers.ValidationError({"email": "Email is required."})
    details = _validated_registration_details(data)

    contact = (
        ContactEmail.objects.select_related("member").filter(email_address__iexact=email).first()
    )
    member = contact.member if contact else None
    Member = get_user_model()

    authorized_temporary_upgrade = _temporary_upgrade_member_id is not None
    if authorized_temporary_upgrade:
        try:
            authorized_member_id = uuid.UUID(str(_temporary_upgrade_member_id))
        except (TypeError, ValueError, AttributeError):
            authorized_member_id = None
        if (
            contact is None
            or member is None
            or member.pk != authorized_member_id
            or member.access_level != Member.AccessLevel.TEMPORARY
            or not member.is_active
        ):
            raise serializers.ValidationError(
                {"email": "Unable to register with this email address."}
            )
        logger.info(
            "temporary_upgrade_registration_started",
            extra={
                "member_id": str(member.pk) if member else None,
                "upgrade_member_id": _temporary_upgrade_member_id,
            },
        )

    if contact is not None and contact.verified:
        raise serializers.ValidationError({"email": "Unable to register with this email address."})

    if member is None:
        member = Member(is_active=False)
        _apply_registration_details(member, details, email=email)
        member.save()
    else:
        _apply_registration_details(member, details, email=email)
        # A normal pending registration remains inactive until email
        # verification. An authenticated temporary member must stay active so
        # its event-scoped session continues working during that same wait.
        if not authorized_temporary_upgrade:
            member.is_active = False
        member.save()

    if contact is None:
        ContactEmail.objects.create(
            member=member,
            email_address=email,
            email_type="primary",
            verified=False,
        )
    else:
        contact.member = member
        contact.email_type = "primary"
        contact.save(update_fields=["member", "email_type", "updated_at"])

    try:
        issue_email_challenge(
            member=member,
            purpose=EmailAuthChallenge.Purpose.REGISTER,
            target_email=email,
            scope_key=(TEMP_SESSION_REGISTRATION_SCOPE if authorized_temporary_upgrade else ""),
        )
    except AuthChallengeDeliveryError:
        raise  # re-raise so the caller can return a 503

    return member
