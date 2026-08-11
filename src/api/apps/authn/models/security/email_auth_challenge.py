"""
Email-based authentication challenges.
"""

from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.core.models import ProjectControlModel


class EmailAuthChallenge(ProjectControlModel):
    """Stores short-lived verification codes for auth-related email flows."""

    class Purpose(models.TextChoices):
        REGISTER = "register", "Register"
        LOGIN = "login", "Login"
        PASSWORD_RESET = "password_reset", "Password Reset"
        PASSWORD_CHANGE = "password_change", "Password Change"
        ACCOUNT_DELETE = "account_delete", "Account Delete"
        CONTACT_EMAIL_VERIFY = "contact_email_verify", "Contact Email Verify"
        ADMIN_LOGIN = "admin_login", "Admin Login"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        VERIFIED = "verified", "Verified"
        CONSUMED = "consumed", "Consumed"
        EXPIRED = "expired", "Expired"

    class Channel(models.TextChoices):
        EMAIL = "email", "Email"
        SMS = "sms", "SMS"

    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="email_auth_challenges",
    )
    purpose = models.CharField(
        max_length=32,
        choices=Purpose.choices,
    )
    channel = models.CharField(
        max_length=8,
        choices=Channel.choices,
        default=Channel.EMAIL,
        help_text="Delivery channel the verification code was sent through.",
    )
    target_email = models.EmailField(
        blank=True,
        default="",
        help_text="Email address where the verification code was sent (email channel).",
    )
    target_phone = models.CharField(
        max_length=20,
        blank=True,
        default="",
        help_text="E.164 phone number where the verification code was sent (SMS channel).",
    )
    code_hash = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text="Hashed verification code. Blank for SMS-channel rows, whose code lives in the OTP cache.",
    )
    verification_token_hash = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text="Hashed token returned after a code is verified.",
    )
    expires_at = models.DateTimeField(
        help_text="When the code or verification token expires.",
    )
    verified_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="When the verification code was successfully checked.",
    )
    attempts = models.PositiveSmallIntegerField(default=0)
    max_attempts = models.PositiveSmallIntegerField(default=5)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
    )
    last_sent_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Last time the code email was sent.",
    )

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["purpose", "target_email", "status"]),
            models.Index(fields=["member", "purpose", "status"]),
            models.Index(fields=["expires_at"]),
        ]

    def __str__(self):
        target = self.target_phone if self.channel == self.Channel.SMS else self.target_email
        return f"{self.get_purpose_display()} -> {target} [{self.status}]"

    @property
    def is_expired(self) -> bool:
        return self.expires_at <= timezone.now()

    def mark_expired(self):
        if self.status == self.Status.EXPIRED:
            return
        self.status = self.Status.EXPIRED
        self.save(update_fields=["status", "updated_at"])

    def mark_verified(self):
        self.status = self.Status.VERIFIED
        self.verified_at = timezone.now()
        self.save(update_fields=["status", "verified_at", "updated_at"])

    def mark_consumed(self):
        self.status = self.Status.CONSUMED
        self.save(update_fields=["status", "updated_at"])

    @classmethod
    def default_expiry(cls):
        return timezone.now() + timedelta(minutes=10)
