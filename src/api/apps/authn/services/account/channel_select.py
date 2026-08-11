"""Verification-channel selection for password create/change flows.

A member may verify a password operation through a verified email or, when no
verified email exists, a verified phone via SMS. The selection order is:

  1. an explicitly requested email that is an eligible (verified) auth email,
  2. the verified primary email,
  3. any verified contact email,
  4. the oldest verified phone (SMS),

otherwise :class:`NoRecoveryChannelError` is raised.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from apps.authn.constants import RECOVERY_CHANNEL_UNAVAILABLE
from apps.authn.services.email.auth_email import get_member_auth_emails, normalize_email

from .recovery import NoRecoveryChannelError


@dataclass(frozen=True)
class RecoveryChannel:
    """Resolved verification channel for a password flow."""

    channel: str  # "email" | "sms"
    target_email: str = ""
    e164: str = ""
    masked_destination: str = ""


def mask_email(email: str) -> str:
    """Mask the local part of an email for display, e.g. ``j•••@gmail.com``."""
    email = (email or "").strip()
    if "@" not in email:
        return email
    local, _, domain = email.partition("@")
    masked_local = (local[0] + "•" * (len(local) - 1)) if len(local) > 1 else (local or "•")
    return f"{masked_local}@{domain}"


def mask_phone(e164: str) -> str:
    """Mask a phone number for display, keeping only the last four digits."""
    digits = re.sub(r"\D", "", e164 or "")
    if not digits:
        return ""
    return f"(•••) •••-{digits[-4:]}"


def select_recovery_channel(member, *, requested_email: str | None = None) -> RecoveryChannel:
    """Pick the password-verification channel for ``member``.

    ``requested_email`` is an optional caller-supplied disambiguator (the legacy
    change-password clients echo the email back); it is only honoured when it is
    one of the member's verified auth emails.
    """
    if requested_email:
        normalized = normalize_email(requested_email)
        if normalized and normalized in set(get_member_auth_emails(member)):
            return RecoveryChannel("email", target_email=normalized, masked_destination=mask_email(normalized))

    primary = member.get_primary_contact_email()
    if primary is not None and primary.verified:
        addr = normalize_email(primary.email_address)
        return RecoveryChannel("email", target_email=addr, masked_destination=mask_email(addr))

    emails = get_member_auth_emails(member)
    if emails:
        return RecoveryChannel("email", target_email=emails[0], masked_destination=mask_email(emails[0]))

    phone = member.contact_phones.filter(verified=True).order_by("created_at").first()
    if phone is not None:
        e164 = phone.to_e164()
        return RecoveryChannel("sms", e164=e164, masked_destination=mask_phone(e164))

    raise NoRecoveryChannelError(RECOVERY_CHANNEL_UNAVAILABLE)
