"""Idempotency record for event duplication requests."""

from django.conf import settings
from django.db import models

from apps.core.models import TimestampedModel

from .event import Event


class EventDuplicationRequest(TimestampedModel):
    source_event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="duplication_requests",
    )
    duplicate_event = models.ForeignKey(
        Event,
        on_delete=models.SET_NULL,
        null=True,
        related_name="source_duplication_requests",
    )
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="event_duplication_requests",
    )
    idempotency_key = models.UUIDField()
    request_fingerprint = models.CharField(max_length=64)
    source_version = models.PositiveBigIntegerField()

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["source_event", "idempotency_key"],
                name="one_event_duplication_per_key",
            ),
            models.CheckConstraint(
                condition=models.Q(source_version__gte=1),
                name="event_duplication_source_version_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.source_event.code} / {self.idempotency_key}"
