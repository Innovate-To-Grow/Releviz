"""Email address parsing, member resolution, and contact phone checks."""

import re

from django.core.exceptions import ValidationError
from django.core.validators import validate_email

from apps.authn.models import ContactEmail

from .errors import ManagedParticipantError

PHONE_MAX_LENGTH = 32
PHONE_MIN_DIGITS = 7
_PHONE_PATTERN = re.compile(r"[0-9 +().\-]+")


def phone_issue(value: str) -> str:
    """Classify an already-stripped phone: "" (fine), "too_long", or "invalid".

    Phones are display-only free text: digits, spaces, and ``+ - ( ) .`` with at
    least seven digits. They are never dialled, so there is no E.164 handling.
    """

    if not value:
        return ""
    if len(value) > PHONE_MAX_LENGTH:
        return "too_long"
    if not _PHONE_PATTERN.fullmatch(value):
        return "invalid"
    if sum(character.isdigit() for character in value) < PHONE_MIN_DIGITS:
        return "invalid"
    return ""


def normalize_phone(value) -> str:
    phone = str(value or "").strip()
    issue = phone_issue(phone)
    if issue == "too_long":
        raise ManagedParticipantError(f"Phone is too long (max {PHONE_MAX_LENGTH}).")
    if issue:
        raise ManagedParticipantError("Enter a valid phone number.")
    return phone


def split_invitation_emails(value) -> tuple[list[str], list[str]]:
    raw_items = value if isinstance(value, list) else re.split(r"[\s,;]+", str(value or ""))
    emails: list[str] = []
    invalid: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        email = str(item or "").strip().lower()
        if not email:
            continue
        try:
            validate_email(email)
        except ValidationError:
            invalid.append(email)
            continue
        if email not in seen:
            seen.add(email)
            emails.append(email)
    return emails, invalid


def resolve_invited_member(email: str):
    contact = (
        ContactEmail.objects.select_related("member")
        .filter(email_address__iexact=email, member__is_active=True)
        .first()
    )
    if contact is None:
        return None
    if contact.verified or getattr(contact.member, "access_level", "full") == "temporary":
        return contact.member
    return None


def member_invitation_emails(member) -> set[str]:
    emails = list(
        ContactEmail.objects.filter(member=member, verified=True).values_list(
            "email_address",
            flat=True,
        )
    )
    if member.email:
        emails.append(member.email)
    return {email.strip().lower() for email in emails if email}
