"""Named groups an event's participants can belong to."""

from django.db import models
from django.db.models.functions import Lower

from apps.core.models import TimestampedModel

from ..events.event import Event


class ParticipantGroup(TimestampedModel):
    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="participant_groups")
    name = models.CharField(max_length=100)

    class Meta:
        ordering = [Lower("name"), "pk"]
        constraints = [
            models.UniqueConstraint(
                "event",
                Lower("name"),
                name="one_group_name_per_event",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} - {self.event.code}"
