"""Client-safe auth/security response messages."""

ENCRYPTED_FIELD_DECRYPT_FAILED = "Failed to decrypt secure field."
VERIFICATION_INVALID = "Verification code is invalid or has expired."
VERIFICATION_LINK_INVALID = "Verification link is invalid or has expired."
VERIFICATION_CONFIRM_INVALID = "Verification token is invalid or has expired."
VERIFICATION_THROTTLED = "Too many verification attempts. Please try again later."
PHONE_VERIFICATION_DELIVERY_FAILED = "Failed to send verification SMS."
RECOVERY_CHANNEL_UNAVAILABLE = (
    "No verified email or phone is available for password verification. Add and verify a contact method first."
)
CONTACT_EMAIL_ADD_FAILED = "Unable to add this email address."
CONTACT_EMAIL_SEND_FAILED = "Unable to send verification code for this email."
CONTACT_EMAIL_PRIMARY_FAILED = "Unable to update primary email."
CONTACT_PHONE_ADD_FAILED = "Unable to add this phone number."
CONTACT_PHONE_SEND_FAILED = "Unable to send verification code for this phone."
LAST_RECOVERY_CONTACT_DELETE_FAILED = (
    "You can't remove your only verified recovery method. Add and verify another email or phone first."
)
UNSUBSCRIBE_LOGIN_INVALID = "Invalid or expired unsubscribe link."
UNSUBSCRIBE_LOGIN_ALREADY_USED = "This unsubscribe link has already been used."
