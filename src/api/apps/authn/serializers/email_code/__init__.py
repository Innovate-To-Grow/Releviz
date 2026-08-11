"""Serializers for email-code auth flows."""

from .account import AccountEmailsSerializer
from .auth import (
    LoginCodeRequestSerializer,
    LoginCodeVerifySerializer,
    RegisterResendCodeSerializer,
    RegisterVerifyCodeSerializer,
    UnifiedEmailAuthRequestSerializer,
    UnifiedEmailAuthVerifySerializer,
)
from .passwords import (
    ChangePasswordCodeConfirmSerializer,
    ChangePasswordCodeRequestSerializer,
    ChangePasswordCodeVerifySerializer,
    DeleteAccountCodeConfirmSerializer,
    DeleteAccountCodeRequestSerializer,
    DeleteAccountCodeVerifySerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    PasswordResetVerifySerializer,
)

__all__ = [
    "AccountEmailsSerializer",
    "ChangePasswordCodeConfirmSerializer",
    "ChangePasswordCodeRequestSerializer",
    "ChangePasswordCodeVerifySerializer",
    "DeleteAccountCodeConfirmSerializer",
    "DeleteAccountCodeRequestSerializer",
    "DeleteAccountCodeVerifySerializer",
    "LoginCodeRequestSerializer",
    "LoginCodeVerifySerializer",
    "PasswordResetConfirmSerializer",
    "PasswordResetRequestSerializer",
    "PasswordResetVerifySerializer",
    "RegisterResendCodeSerializer",
    "RegisterVerifyCodeSerializer",
    "UnifiedEmailAuthRequestSerializer",
    "UnifiedEmailAuthVerifySerializer",
]
