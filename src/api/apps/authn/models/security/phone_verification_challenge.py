from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.core.models import ProjectControlModel


class PhoneVerificationChallenge(ProjectControlModel):
    """Durable, one-time SMS verification challenge.

    The UUID primary key is returned to clients as ``challenge_id``.  Keeping the
    code hash and attempt state in the database lets verification use row locks
    and conditional status transitions across processes.
    """

    class Purpose(models.TextChoices):
        PHONE_AUTH = "phone_auth", "Phone authentication"
        CONTACT_PHONE_VERIFY = "contact_phone_verify", "Contact phone verification"
        PASSWORD_RESET = "password_reset", "Password reset"
        PASSWORD_CHANGE = "password_change", "Password change"
        EVENT_REGISTRATION = "event_registration", "Event registration"

    class Status(models.TextChoices):
        SENDING = "sending", "Sending"
        PENDING = "pending", "Pending"
        VERIFIED = "verified", "Verified"
        CONSUMED = "consumed", "Consumed"
        EXPIRED = "expired", "Expired"

    phone_number = models.CharField(max_length=20, db_index=True, help_text="Destination phone in E.164 format.")
    purpose = models.CharField(max_length=32, choices=Purpose.choices, default=Purpose.PHONE_AUTH)
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="+",
    )
    context_identifier = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text="Purpose-specific resource or flow identifier bound to this challenge.",
    )
    code_hash = models.CharField(max_length=255)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
    )
    attempts = models.PositiveSmallIntegerField(default=0)
    max_attempts = models.PositiveSmallIntegerField(default=5)
    expires_at = models.DateTimeField()
    verified_at = models.DateTimeField(null=True, blank=True)
    consumed_at = models.DateTimeField(null=True, blank=True)
    send_reserved_at = models.DateTimeField(null=True, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["phone_number", "purpose", "status"],
                name="authn_phone_lookup_idx",
            ),
            models.Index(fields=["expires_at"], name="authn_phone_expiry_idx"),
            models.Index(
                fields=["phone_number", "send_reserved_at"],
                name="authn_phone_send_cap_idx",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["phone_number", "purpose"],
                condition=models.Q(status__in=["sending", "pending", "verified"]),
                name="one_active_phone_challenge",
            ),
        ]

    @classmethod
    def default_expiry(cls):
        return timezone.now() + timedelta(minutes=10)

    @property
    def is_expired(self) -> bool:
        return self.expires_at <= timezone.now()

    def __str__(self):
        return f"{self.get_purpose_display()} -> {self.phone_number} [{self.status}]"
