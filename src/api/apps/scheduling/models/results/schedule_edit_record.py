"""Audit trail for availability edits."""

from django.conf import settings
from django.db import models

from apps.core.models import TimestampedModel

from ..events.event import Event
from ..participants.participant import Participant


class ScheduleEditRecord(TimestampedModel):
    class Source(models.TextChoices):
        SELF = "self", "Participant"
        ORGANIZER = "organizer", "Organizer"
        IMPORT = "import", "Import"
        SYSTEM = "system", "System"

    class Action(models.TextChoices):
        DRAFT = "draft", "Draft"
        SUBMIT = "submit", "Submit"
        WITHDRAW = "withdraw", "Withdraw"

    event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="schedule_edit_records",
    )
    participant = models.ForeignKey(
        Participant,
        on_delete=models.CASCADE,
        related_name="schedule_edit_records",
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="schedule_edit_records",
    )
    # Keep the immutable identity even when taking a Member foreign-key lock
    # would invert the temporary-account upgrade lock order. Temporary users
    # therefore record this identifier without populating ``actor``.
    actor_identifier = models.UUIDField(null=True, blank=True)
    source = models.CharField(max_length=16, choices=Source.choices)
    action = models.CharField(max_length=16, choices=Action.choices)
    participant_version = models.PositiveBigIntegerField()

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(participant_version__gte=1),
                name="schedule_edit_participant_version_positive",
            ),
        ]
        indexes = [
            models.Index(fields=["event", "created_at"]),
            models.Index(fields=["participant", "created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.event.code} / {self.participant_id} / {self.action}"
