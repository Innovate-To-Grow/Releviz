import uuid

from django.db import models
from django.utils import timezone

from ..base import ProjectControlModel


class BackgroundJob(ProjectControlModel):
    """Durable PostgreSQL outbox entry processed by the background worker."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PROCESSING = "processing", "Processing"
        RETRY = "retry", "Retry scheduled"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"
        UNCERTAIN = "uncertain", "Uncertain delivery"
        CANCELLED = "cancelled", "Cancelled"

    kind = models.CharField(max_length=80, db_index=True)
    dedupe_key = models.CharField(max_length=255)
    payload = models.JSONField(default=dict)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    attempts = models.PositiveSmallIntegerField(default=0)
    max_attempts = models.PositiveSmallIntegerField(default=5)
    available_at = models.DateTimeField(default=timezone.now, db_index=True)
    claim_token = models.UUIDField(null=True, blank=True, editable=False)
    claimed_at = models.DateTimeField(null=True, blank=True, editable=False)
    provider_call_started_at = models.DateTimeField(null=True, blank=True, editable=False)
    can_retry_after_claim = models.BooleanField(
        default=True,
        help_text=(
            "Whether a stale claimed job is safe to retry. Disable for provider "
            "deliveries whose outcome cannot be queried idempotently."
        ),
    )
    completed_at = models.DateTimeField(null=True, blank=True, editable=False)
    last_error = models.TextField(blank=True, default="", editable=False)

    class Meta:
        ordering = ["available_at", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["kind", "dedupe_key"],
                name="unique_background_job_dedupe_key",
            ),
        ]
        indexes = [
            models.Index(
                fields=["status", "available_at", "created_at"],
                name="core_job_claim_idx",
            ),
            models.Index(
                fields=["status", "claimed_at"],
                name="core_job_stale_idx",
            ),
        ]

    def begin_provider_call(self) -> bool:
        """Persist the point after which a delivery result may be unknowable."""
        now = timezone.now()
        updated = (
            type(self)
            .objects.filter(
                pk=self.pk,
                status=self.Status.PROCESSING,
                claim_token=self.claim_token,
                provider_call_started_at__isnull=True,
            )
            .update(provider_call_started_at=now, updated_at=now)
        )
        if updated:
            self.provider_call_started_at = now
        return bool(updated)

    def __str__(self):
        return f"{self.kind}:{self.dedupe_key} [{self.status}]"

    @staticmethod
    def new_claim_token() -> uuid.UUID:
        return uuid.uuid4()
