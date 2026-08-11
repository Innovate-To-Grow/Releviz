"""Verification-channel selection for password create/change flows.

A member may verify a password operation through a verified email. The selection
order is:

  1. an explicitly requested email that is an eligible (verified) auth email,
  2. the verified primary email,
  3. any verified contact email,

otherwise :class:`NoRecoveryChannelError` is raised.
"""

from __future__ import annotations

from dataclasses import dataclass

from apps.authn.constants import RECOVERY_CHANNEL_UNAVAILABLE
from apps.authn.services.email.auth_email import get_member_auth_emails, normalize_email

from .recovery import NoRecoveryChannelError


@dataclass(frozen=True)
class RecoveryChannel:
    """Resolved verification channel for a password flow."""

    target_email: str = ""
    masked_destination: str = ""


def mask_email(email: str) -> str:
    """Mask the local part of an email for display, e.g. ``j•••@gmail.com``."""
    email = (email or "").strip()
    if "@" not in email:
        return email
    local, _, domain = email.partition("@")
    masked_local = (local[0] + "•" * (len(local) - 1)) if len(local) > 1 else (local or "•")
    return f"{masked_local}@{domain}"


def select_recovery_channel(member, *, requested_email: str | None = None) -> RecoveryChannel:
    """Pick the password-verification channel for ``member``.

    ``requested_email`` is an optional caller-supplied disambiguator (the legacy
    change-password clients echo the email back); it is only honoured when it is
    one of the member's verified auth emails.
    """
    if requested_email:
        normalized = normalize_email(requested_email)
        if normalized and normalized in set(get_member_auth_emails(member)):
            return RecoveryChannel(target_email=normalized, masked_destination=mask_email(normalized))

    primary = member.get_primary_contact_email()
    if primary is not None and primary.verified:
        addr = normalize_email(primary.email_address)
        return RecoveryChannel(target_email=addr, masked_destination=mask_email(addr))

    emails = get_member_auth_emails(member)
    if emails:
        return RecoveryChannel(target_email=emails[0], masked_destination=mask_email(emails[0]))

    raise NoRecoveryChannelError(RECOVERY_CHANNEL_UNAVAILABLE)
