"""Pending signal telling the worker to recompute an event's results."""

from django.db import models

from apps.core.models import TimestampedModel

from ..events.event import Event


class EventResultInvalidation(TimestampedModel):
    """Durable, low-contention signal from a response write to the result worker."""

    event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="result_invalidations",
    )
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(
                fields=["event", "processed_at", "created_at"],
                name="result_inval_event_pending_idx",
            )
        ]

    def __str__(self) -> str:
        state = "processed" if self.processed_at else "pending"
        return f"{self.event.code} result invalidation [{state}]"
