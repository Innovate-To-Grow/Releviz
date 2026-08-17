"""Per-event participant records and their availability."""

from django.conf import settings
from django.db import models

from apps.core.models import TimestampedModel

from ..events.event import Event


class Participant(TimestampedModel):
    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="participants")
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="schedule_participations",
    )
    participant_name = models.CharField(max_length=100)
    availability_inperson = models.JSONField(default=list)
    availability_virtual = models.JSONField(default=list)
    submitted = models.BooleanField(default=False)
    first_draft_saved_at = models.DateTimeField(null=True, blank=True)
    first_submitted_at = models.DateTimeField(null=True, blank=True)
    last_submitted_at = models.DateTimeField(null=True, blank=True)
    hidden = models.BooleanField(default=False)
    group_name = models.CharField(max_length=100, null=True, blank=True)
    sort_order = models.IntegerField(null=True, blank=True)
    version = models.PositiveBigIntegerField(default=1)

    class Meta:
        ordering = ["sort_order", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["event", "member"], name="one_participant_per_member_event"
            ),
            models.CheckConstraint(
                condition=models.Q(version__gte=1),
                name="participant_version_is_positive",
            ),
        ]
        indexes = [
            models.Index(fields=["event", "submitted"]),
            models.Index(fields=["first_submitted_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.participant_name} - {self.event.code}"
