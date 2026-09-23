"""Per-event participant records and their availability."""

from django.conf import settings
from django.db import models

from apps.core.models import TimestampedModel

from ..events.event import Event
from .group import ParticipantGroup


class Participant(TimestampedModel):
    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="participants")
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="schedule_participations",
    )
    participant_name = models.CharField(max_length=100)
    # Display-only contact details. ``contact_email`` is set for organizer-managed
    # people, whose address belongs to the organizer and never becomes an identity;
    # ``contact_phone`` is free text and is never used for delivery or login.
    contact_email = models.EmailField(blank=True, default="")
    contact_phone = models.CharField(max_length=32, blank=True, default="")
    organizer_managed = models.BooleanField(default=False, db_index=True)
    availability_inperson = models.JSONField(default=list)
    availability_virtual = models.JSONField(default=list)
    submitted = models.BooleanField(default=False)
    first_draft_saved_at = models.DateTimeField(null=True, blank=True)
    first_submitted_at = models.DateTimeField(null=True, blank=True)
    last_submitted_at = models.DateTimeField(null=True, blank=True)
    # Set the first time the person acts on this response themselves (joins, saves or
    # submits their own response, or upgrades a temporary identity). While NULL on a
    # full account, the event organizer may still enter the response for them. Never
    # cleared while the row exists.
    response_claimed_at = models.DateTimeField(null=True, blank=True)
    hidden = models.BooleanField(default=False)
    groups = models.ManyToManyField(ParticipantGroup, related_name="participants", blank=True)
    # Membership in every group the event has now or gains later.
    all_groups = models.BooleanField(default=False)
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
