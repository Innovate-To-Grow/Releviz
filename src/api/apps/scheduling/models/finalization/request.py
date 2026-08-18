"""Idempotency record for finalization requests."""

from django.db import models

from apps.core.models import TimestampedModel

from ..events.event import Event
from .final_meeting import FinalMeeting


class FinalizationRequest(TimestampedModel):
    event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="finalization_requests",
    )
    final_meeting = models.ForeignKey(
        FinalMeeting,
        on_delete=models.CASCADE,
        related_name="confirmation_requests",
    )
    idempotency_key = models.UUIDField()
    request_fingerprint = models.CharField(max_length=64)
    meeting_sequence = models.PositiveIntegerField()
    resulting_event_version = models.PositiveBigIntegerField()

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["event", "idempotency_key"],
                name="one_finalization_request_per_key",
            ),
            models.CheckConstraint(
                condition=models.Q(resulting_event_version__gte=1),
                name="finalization_event_version_is_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.event.code} / {self.idempotency_key}"
