"""Membership edge between a member and an event."""

from django.conf import settings
from django.db import models

from apps.core.models import TimestampedModel

from ..events.event import Event


class UserEvent(TimestampedModel):
    ROLE_CHOICES = [
        ("organizer", "Organizer"),
        ("participant", "Participant"),
    ]

    member = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="user_events"
    )
    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="user_events")
    role = models.CharField(max_length=16, choices=ROLE_CHOICES)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["member", "event", "role"], name="one_user_event_role")
        ]

    def __str__(self) -> str:
        return f"{self.member_id} {self.role} {self.event.code}"
