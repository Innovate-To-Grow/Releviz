import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.core.models import TimestampedModel


class EmailProviderConfig(TimestampedModel):
    """Email sender identity configuration.

    AWS IAM credentials are managed by the shared AWSCredentialConfig
    model (core). This model only holds email-specific fields: the
    verified sender address (from_email) and optional reply-to address.
    """

    name = models.CharField(max_length=120, default="Default")
    is_active = models.BooleanField(default=True)
    from_email = models.EmailField(
        verbose_name="From Email",
        help_text="Verified SES sender address (e.g. noreply@example.com).",
    )
    reply_to_email = models.EmailField(
        blank=True,
        default="",
        verbose_name="Reply-To Email",
        help_text="Optional reply-to address for outgoing emails.",
    )
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

    def __str__(self) -> str:
        state = "active" if self.is_active else "inactive"
        return f"{self.name} ({self.from_email}, {state})"


class EmailMessageLog(TimestampedModel):
    class MessageType(models.TextChoices):
        VERIFICATION = "verification", "Verification"
        WELCOME = "welcome", "Welcome"
        LOGIN_ALERT = "login_alert", "Login Alert"
        INVITATION = "invitation", "Invitation"
        REMINDER = "reminder", "Reminder"
        FINAL_CONFIRMATION = "final_confirmation", "Final Confirmation"
        FINAL_CANCELLATION = "final_cancellation", "Final Cancellation"
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
    delivery_job = models.ForeignKey(
        "mail.EmailDeliveryJob",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="message_logs",
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


class EmailDeliveryJob(TimestampedModel):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PROCESSING = "processing", "Processing"
        RETRY = "retry", "Retry"
        SENT = "sent", "Sent"
        PERMANENT_FAILURE = "permanent_failure", "Permanent Failure"
        UNCERTAIN = "uncertain", "Uncertain Delivery"
        CANCELED = "canceled", "Canceled"

    idempotency_key = models.CharField(max_length=255, unique=True)
    message_type = models.CharField(max_length=32, choices=EmailMessageLog.MessageType.choices)
    recipient = models.EmailField()
    subject = models.CharField(max_length=255)
    body = models.TextField()
    html_body = models.TextField(blank=True, default="")
    content_encrypted = models.BooleanField(default=False)
    attachments = models.JSONField(default=list)
    message_id = models.CharField(max_length=255, unique=True)
    event = models.ForeignKey(
        "scheduling.Event",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="email_delivery_jobs",
    )
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="email_delivery_jobs",
    )
    auth_challenge = models.OneToOneField(
        "authn.EmailAuthChallenge",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="delivery_job",
    )
    # auth_session field removed — authn.AuthSession model no longer exists
    invitation = models.ForeignKey(
        "scheduling.EventInvitation",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="email_delivery_jobs",
    )
    status = models.CharField(
        max_length=24,
        choices=Status.choices,
        default=Status.PENDING,
    )
    attempt_count = models.PositiveSmallIntegerField(default=0)
    max_attempts = models.PositiveSmallIntegerField(default=5)
    next_attempt_at = models.DateTimeField(default=timezone.now)
    locked_at = models.DateTimeField(null=True, blank=True)
    lock_token = models.UUIDField(null=True, blank=True)
    provider_call_started_at = models.DateTimeField(null=True, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    provider_message_id = models.CharField(max_length=255, blank=True, default="")
    last_error = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["next_attempt_at", "created_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(max_attempts__gte=1),
                name="email_job_max_attempts_is_positive",
            ),
            models.CheckConstraint(
                condition=models.Q(event__isnull=False) | models.Q(member__isnull=False),
                name="email_job_has_domain_owner",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "next_attempt_at"]),
            models.Index(fields=["event", "message_type"]),
            models.Index(fields=["member", "message_type"]),
        ]

    def reset_lock(self) -> None:
        self.locked_at = None
        self.lock_token = None

    def new_lock_token(self):
        return uuid.uuid4()

    def __str__(self) -> str:
        return f"{self.message_type} to {self.recipient} [{self.status}]"


class EmailDeliveryRequest(TimestampedModel):
    class Operation(models.TextChoices):
        INVITATION = "invitation", "Invitation"
        REMINDER = "reminder", "Reminder"
        FINAL_CONFIRMATION = "final_confirmation", "Final confirmation"
        FINAL_CANCELLATION = "final_cancellation", "Final cancellation"

    event = models.ForeignKey(
        "scheduling.Event",
        on_delete=models.CASCADE,
        related_name="email_delivery_requests",
    )
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="email_delivery_requests",
    )
    operation = models.CharField(max_length=24, choices=Operation.choices)
    idempotency_key = models.UUIDField()
    request_fingerprint = models.CharField(max_length=64)
    recipient_count = models.PositiveIntegerField(default=0)
    created_job_count = models.PositiveIntegerField(default=0)
    jobs = models.ManyToManyField(
        EmailDeliveryJob,
        blank=True,
        related_name="delivery_requests",
    )

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["event", "operation", "idempotency_key"],
                name="one_email_delivery_request_per_key",
            )
        ]
        indexes = [
            models.Index(fields=["event", "operation", "created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.operation} for {self.event.code} / {self.idempotency_key}"
