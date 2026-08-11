from django.contrib.auth import get_user_model

from apps.authn.forms.admin_login import (
    AdminCodeForm,
    AdminEmailForm,
    AdminPasswordForm,
    AdminRememberedPasswordForm,
)
from apps.authn.models.security import EmailAuthChallenge
from apps.authn.services.email.challenges import (
    AuthChallengeDeliveryError,
    AuthChallengeInvalid,
    AuthChallengeThrottled,
    issue_email_challenge,
    verify_email_code,
)

from .view import AdminLoginView

Member = get_user_model()
PURPOSE = EmailAuthChallenge.Purpose.ADMIN_LOGIN

__all__ = [
    "AdminCodeForm",
    "AdminEmailForm",
    "AdminLoginView",
    "AdminPasswordForm",
    "AdminRememberedPasswordForm",
    "AuthChallengeDeliveryError",
    "AuthChallengeInvalid",
    "AuthChallengeThrottled",
    "Member",
    "PURPOSE",
    "issue_email_challenge",
    "verify_email_code",
]
