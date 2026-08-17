"""Cached aggregation payload for an event's results."""

from django.db import models

from apps.core.models import TimestampedModel

from ..events.event import Event


class EventResultSnapshot(TimestampedModel):
    class Status(models.TextChoices):
        REFRESHING = "refreshing", "Refreshing"
        FRESH = "fresh", "Fresh"
        FAILED = "failed", "Failed"

    event = models.OneToOneField(
        Event,
        on_delete=models.CASCADE,
        related_name="result_snapshot",
    )
    requested_revision = models.PositiveBigIntegerField(default=1)
    computed_revision = models.PositiveBigIntegerField(default=0)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.REFRESHING,
    )
    payload = models.JSONField(default=dict)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")
    locked_at = models.DateTimeField(null=True, blank=True)
    lock_token = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(requested_revision__gte=0),
                name="result_snapshot_requested_revision_nonnegative",
            ),
            models.CheckConstraint(
                condition=models.Q(computed_revision__gte=0),
                name="result_snapshot_computed_revision_nonnegative",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "updated_at"]),
            models.Index(fields=["locked_at"]),
        ]

    def __str__(self) -> str:
        return (
            f"{self.event.code} results {self.computed_revision}/"
            f"{self.requested_revision} [{self.status}]"
        )
