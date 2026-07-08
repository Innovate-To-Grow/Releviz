from django.db import models

from apps.core.models import TimestampedModel
from apps.messaging.crypto import decrypt_secret, encrypt_secret


class EmailProviderConfig(TimestampedModel):
    name = models.CharField(max_length=120, default="AWS SES")
    is_active = models.BooleanField(default=True)
    aws_region = models.CharField(max_length=64, default="us-west-2")
    from_email = models.EmailField()
    reply_to_email = models.EmailField(blank=True, default="")
    aws_access_key_id = models.CharField(max_length=255)
    encrypted_secret_access_key = models.TextField(blank=True, default="")
    last_tested_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["-is_active", "name", "-created_at"]

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)
        if self.is_active:
            EmailProviderConfig.objects.exclude(pk=self.pk).filter(is_active=True).update(
                is_active=False
            )

    def set_secret_access_key(self, value: str):
        if value:
            self.encrypted_secret_access_key = encrypt_secret(value)

    def get_secret_access_key(self) -> str:
        return decrypt_secret(self.encrypted_secret_access_key)

    def __str__(self) -> str:
        state = "active" if self.is_active else "inactive"
        return f"{self.name} ({self.aws_region}, {state})"


class EmailMessageLog(TimestampedModel):
    class MessageType(models.TextChoices):
        VERIFICATION = "verification", "Verification"
        WELCOME = "welcome", "Welcome"
        LOGIN_ALERT = "login_alert", "Login Alert"
        INVITATION = "invitation", "Invitation"
        REMINDER = "reminder", "Reminder"
        TEST = "test", "Test"

    class Status(models.TextChoices):
        SENT = "sent", "Sent"
        FAILED = "failed", "Failed"

    message_type = models.CharField(max_length=32, choices=MessageType.choices)
    recipient = models.EmailField()
    subject = models.CharField(max_length=255)
    status = models.CharField(max_length=16, choices=Status.choices)
    provider_message_id = models.CharField(max_length=255, blank=True, default="")
    error = models.TextField(blank=True, default="")
    event = models.ForeignKey(
        "scheduling.Event",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="email_logs",
    )
    invitation = models.ForeignKey(
        "scheduling.EventInvitation",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="email_logs",
    )

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["message_type", "status"]),
            models.Index(fields=["recipient"]),
            models.Index(fields=["created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.message_type} to {self.recipient} [{self.status}]"
