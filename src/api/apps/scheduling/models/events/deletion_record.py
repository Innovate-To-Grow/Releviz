"""Tombstone record kept after an event is deleted."""

from django.conf import settings
from django.db import models

from apps.core.models import TimestampedModel


class EventDeletionRecord(TimestampedModel):
    event_id = models.UUIDField(unique=True)
    code = models.CharField(max_length=16, unique=True)
    organizer = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="event_deletion_records",
    )
    idempotency_key = models.UUIDField()
    request_fingerprint = models.CharField(max_length=64)
    deleted_version = models.PositiveBigIntegerField()

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["organizer", "idempotency_key"],
                name="one_event_deletion_per_member_key",
            ),
            models.CheckConstraint(
                condition=models.Q(deleted_version__gte=1),
                name="event_deletion_version_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} deleted at version {self.deleted_version}"
