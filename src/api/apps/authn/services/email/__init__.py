"""Email-related auth service modules."""

from .auth_email import (
    ResolvedAuthEmail,
    claim_unclaimed_contact_email,
    get_member_auth_emails,
    get_pending_registration_member,
    normalize_email,
    registration_email_conflicts,
    resolve_auth_email,
)
from .challenges import (
    AuthChallengeDeliveryError,
    AuthChallengeError,
    AuthChallengeInvalid,
    AuthChallengeThrottled,
    consume_login_or_registration_challenge,
    consume_verification_token,
    issue_email_challenge,
    mark_challenge_verified,
    verify_email_code,
    verify_email_code_and_mint_token,
    verify_email_code_for_purposes,
)
from .send_email import send_admin_invitation_email, send_notification_email, send_verification_email

__all__ = [
    "AuthChallengeDeliveryError",
    "AuthChallengeError",
    "AuthChallengeInvalid",
    "AuthChallengeThrottled",
    "ResolvedAuthEmail",
    "claim_unclaimed_contact_email",
    "consume_login_or_registration_challenge",
    "consume_verification_token",
    "get_member_auth_emails",
    "get_pending_registration_member",
    "issue_email_challenge",
    "mark_challenge_verified",
    "normalize_email",
    "registration_email_conflicts",
    "resolve_auth_email",
    "send_admin_invitation_email",
    "send_notification_email",
    "send_verification_email",
    "verify_email_code",
    "verify_email_code_and_mint_token",
    "verify_email_code_for_purposes",
]
