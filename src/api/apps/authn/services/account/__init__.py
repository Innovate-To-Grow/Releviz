"""Account services: deletion, recovery channel selection, unsubscribe."""

from .channel_select import RecoveryChannel, mask_email, select_recovery_channel
from .delete_account import delete_member_account
from .recovery import (
    LastRecoveryContactError,
    NoRecoveryChannelError,
    count_verified_recovery_contacts,
)
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
    # Recovery contacts
    "count_verified_recovery_contacts",
    "LastRecoveryContactError",
    "NoRecoveryChannelError",
    # Unsubscribe tokens
    "UnsubscribeLoginTokenAlreadyUsed",
    "UnsubscribeLoginTokenInvalid",
    "build_unsubscribe_login_token",
    "build_unsubscribe_url",
    "get_member_from_unsubscribe_token",
]
