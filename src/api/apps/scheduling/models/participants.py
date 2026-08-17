"""Participation rows, organizer weights, membership links, and the edit audit log."""

from django.conf import settings
from django.db import models

from apps.core.models import TimestampedModel
from apps.scheduling.models.events import Event


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
