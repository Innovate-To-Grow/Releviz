"""Organizer-assigned weighting for a participant's availability."""

from django.db import models

from apps.core.models import TimestampedModel

from ..events.event import Event
from .participant import Participant


class Weight(TimestampedModel):
    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="weights")
    participant = models.ForeignKey(Participant, on_delete=models.CASCADE, related_name="weights")
    weight = models.FloatField(default=1.0)
    included = models.BooleanField(default=True)

    class Meta:
        ordering = ["participant__participant_name"]
        constraints = [
            models.UniqueConstraint(
                fields=["event", "participant"], name="one_weight_per_event_participant"
            ),
            models.CheckConstraint(
                condition=models.Q(weight__gte=0.0, weight__lte=1.0),
                name="weight_between_zero_and_one",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.event.code} / {self.participant.participant_name}: {self.weight}"
