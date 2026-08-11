"""Account services: deletion, recovery channel selection, SMS password bridge, unsubscribe."""

from .channel_select import RecoveryChannel, mask_email, mask_phone, select_recovery_channel
from .delete_account import delete_member_account
from .recovery import (
    LastRecoveryContactError,
    NoRecoveryChannelError,
    count_verified_recovery_contacts,
)
from .sms_password import request_sms_password_code, verify_sms_password_code_and_mint
from .unsubscribe import (
    UnsubscribeLoginTokenAlreadyUsed,
    UnsubscribeLoginTokenInvalid,
    build_unsubscribe_login_token,
    build_unsubscribe_url,
    get_member_from_unsubscribe_token,
)

__all__ = [
    "delete_member_account",
    # Recovery channel selection
    "RecoveryChannel",
    "select_recovery_channel",
    "mask_email",
    "mask_phone",
    # Recovery contacts
    "count_verified_recovery_contacts",
    "LastRecoveryContactError",
    "NoRecoveryChannelError",
    # SMS password bridge
    "request_sms_password_code",
    "verify_sms_password_code_and_mint",
    # Unsubscribe tokens
    "UnsubscribeLoginTokenAlreadyUsed",
    "UnsubscribeLoginTokenInvalid",
    "build_unsubscribe_login_token",
    "build_unsubscribe_url",
    "get_member_from_unsubscribe_token",
]
