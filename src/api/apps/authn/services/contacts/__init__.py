"""Contact-related auth service modules."""

from .contact_emails import (
    create_contact_email,
    delete_contact_email,
    resend_contact_email_verification,
    verify_contact_email_code,
)
from .contact_phones import (
    create_contact_phone,
    delete_contact_phone,
    request_phone_verification,
    verify_phone_code,
)

__all__ = [
    "create_contact_email",
    "delete_contact_email",
    "resend_contact_email_verification",
    "verify_contact_email_code",
    "create_contact_phone",
    "delete_contact_phone",
    "request_phone_verification",
    "verify_phone_code",
]
