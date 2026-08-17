"""The confirmed meeting produced by finalizing an event."""

from django.conf import settings
from django.db import models

from apps.core.models import TimestampedModel
from apps.scheduling.validators import validate_iana_timezone

from ..events.event import Event


class FinalMeeting(TimestampedModel):
    CHANNEL_CHOICES = [
        ("inperson", "In person"),
        ("virtual", "Virtual"),
    ]

    event = models.OneToOneField(
        Event,
        on_delete=models.CASCADE,
        related_name="final_meeting",
    )
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    timezone = models.CharField(max_length=64, validators=[validate_iana_timezone])
    channel = models.CharField(max_length=16, choices=CHANNEL_CHOICES)
    location = models.CharField(max_length=500, blank=True, default="")
    calendar_uid = models.CharField(max_length=255, unique=True)
    calendar_sequence = models.PositiveIntegerField(default=0)
    attendance_snapshot = models.JSONField(default=dict)
    confirmed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="confirmed_final_meetings",
    )
    confirmed_at = models.DateTimeField()
    active = models.BooleanField(default=True)
    canceled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-confirmed_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(ends_at__gt=models.F("starts_at")),
                name="final_meeting_ends_after_start",
            )
        ]
        indexes = [
            models.Index(fields=["active", "starts_at"]),
        ]

    def __str__(self) -> str:
        state = "active" if self.active else "canceled"
        return f"{self.event.code} at {self.starts_at.isoformat()} [{state}]"
