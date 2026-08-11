"""Recovery-contact helpers shared by the password and email-deletion flows."""

from __future__ import annotations

from apps.authn.models import ContactEmail
from apps.authn.services.email.challenges import AuthChallengeError


class LastRecoveryContactError(AuthChallengeError):
    """Raised when deleting an email would remove the member's last verified recovery contact."""


class NoRecoveryChannelError(AuthChallengeError):
    """Raised when a member has no verified email to verify a password create/change."""


def count_verified_recovery_contacts(member, *, exclude_email_pk=None) -> int:
    """Count the member's verified recovery contacts (verified emails).

    ``exclude_email_pk`` lets callers ask "what would remain after deleting this contact?".
    """
    emails = ContactEmail.objects.filter(member=member, verified=True)
    if exclude_email_pk is not None:
        emails = emails.exclude(pk=exclude_email_pk)
    return emails.count()
