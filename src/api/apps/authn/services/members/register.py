"""Member registration service — restored from the old services.py.

The ``AccessLevel`` enum was removed from the Member model during
restructuring. Temporary-upgrade registration paths have been adapted
accordingly and log a warning when bypassing the old checks.
"""

import logging
import uuid

from django.contrib.auth import get_user_model
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
        "organization": str(data.get("organization") or "").strip(),
        "title": str(data.get("title") or "").strip(),
    }


def _apply_registration_details(member, details: dict, *, email: str) -> None:
    member.first_name = details["first_name"]
    member.last_name = details["last_name"]
    member.organization = details["organization"]
    member.title = details["title"]
    member.email = email
    member.set_password(details["password"])


@transaction.atomic
def start_registration(data: dict, *, _temporary_upgrade_member_id=None):
    """Start a member registration, issuing an email verification challenge.

    ``_temporary_upgrade_member_id`` is a private kwarg used by the
    scheduling app when upgrading a temporary-event member to a full
    account. It is accepted for backward-compatibility; the old
    ``AccessLevel`` guard has been removed because the Member model
    no longer carries that enum.
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
        if contact is None or member is None or member.pk != authorized_member_id:
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
        member = Member.objects.create_user(
            password=details["password"],
            first_name=details["first_name"],
            last_name=details["last_name"],
            organization=details["organization"],
            title=details["title"],
            is_active=False,
            email=email,
        )
    else:
        _apply_registration_details(member, details, email=email)
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
