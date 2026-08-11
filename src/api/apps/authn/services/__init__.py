"""
Authn app services.
"""

from .account import (
    LastRecoveryContactError,
    NoRecoveryChannelError,
    RecoveryChannel,
    count_verified_recovery_contacts,
    delete_member_account,
    mask_email,
    mask_phone,
    request_sms_password_code,
    select_recovery_channel,
    verify_sms_password_code_and_mint,
)
from .contacts.contact_emails import (
    create_contact_email,
    delete_contact_email,
    make_contact_email_primary,
    resend_contact_email_verification,
    verify_contact_email_code,
)
from .contacts.contact_phones import (
    create_contact_phone,
    delete_contact_phone,
    request_phone_verification,
    verify_phone_code,
)
from .contacts.phone_auth import (
    PhoneAccountInactive,
    request_phone_auth,
    resolve_or_create_member_by_phone,
)
from .email.auth_email import (
    ResolvedAuthEmail,
    ResolvedLoginIdentifier,
    claim_unclaimed_contact_email,
    get_member_auth_emails,
    get_pending_registration_member,
    normalize_email,
    registration_email_conflicts,
    resolve_auth_email,
    resolve_login_identifier,
)
from .email.challenges import (
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
from .members.create import CreateMemberService
from .members.import_ import (
    ImportResult,
    generate_template_excel,
    import_members_from_excel,
)
from .security import (
    RSADecryptionError,
    decrypt_password,
    get_or_create_auth_keypair,
    get_public_key_pem,
    is_encrypted_password,
    purge_retired_auth_keypairs,
    rotate_auth_keypair,
)
from .sms import (
    PhoneVerificationDeliveryError,
    PhoneVerificationError,
    PhoneVerificationInvalid,
    PhoneVerificationThrottled,
)

__all__ = [
    "CreateMemberService",
    "import_members_from_excel",
    "generate_template_excel",
    "ImportResult",
    "delete_member_account",
    # Account recovery (password channel selection + SMS bridge)
    "RecoveryChannel",
    "select_recovery_channel",
    "mask_email",
    "mask_phone",
    "count_verified_recovery_contacts",
    "LastRecoveryContactError",
    "NoRecoveryChannelError",
    "request_sms_password_code",
    "verify_sms_password_code_and_mint",
    # Auth email helpers
    "ResolvedAuthEmail",
    "ResolvedLoginIdentifier",
    "normalize_email",
    "resolve_auth_email",
    "resolve_login_identifier",
    "get_member_auth_emails",
    "claim_unclaimed_contact_email",
    "get_pending_registration_member",
    "registration_email_conflicts",
    "issue_email_challenge",
    "verify_email_code",
    "verify_email_code_and_mint_token",
    "verify_email_code_for_purposes",
    "mark_challenge_verified",
    "consume_verification_token",
    "consume_login_or_registration_challenge",
    "AuthChallengeError",
    "AuthChallengeInvalid",
    "AuthChallengeThrottled",
    "AuthChallengeDeliveryError",
    # Contact emails
    "create_contact_email",
    "verify_contact_email_code",
    "resend_contact_email_verification",
    "delete_contact_email",
    "make_contact_email_primary",
    # Contact phones
    "create_contact_phone",
    "delete_contact_phone",
    "request_phone_verification",
    "verify_phone_code",
    # Passwordless phone auth
    "request_phone_auth",
    "resolve_or_create_member_by_phone",
    "PhoneAccountInactive",
    # SMS exceptions
    "PhoneVerificationError",
    "PhoneVerificationInvalid",
    "PhoneVerificationThrottled",
    "PhoneVerificationDeliveryError",
    # RSA Manager
    "get_or_create_auth_keypair",
    "rotate_auth_keypair",
    "get_public_key_pem",
    "decrypt_password",
    "is_encrypted_password",
    "purge_retired_auth_keypairs",
    "RSADecryptionError",
]
