import uuid

from django.conf import settings
from django.db import models

from apps.core.models import TimestampedModel


class Event(TimestampedModel):
    MODE_CHOICES = [
        ("inperson", "In person"),
        ("virtual", "Virtual"),
        ("mixed", "Mixed"),
    ]
    VIEW_PERMISSION_CHOICES = [
        ("own_only", "Own only"),
        ("all", "All after submit"),
        ("realtime", "Realtime"),
    ]
    DAY_SELECTION_CHOICES = [
        ("days_of_week", "Days of week"),
        ("specific_dates", "Specific dates"),
    ]

    event_id = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    code = models.CharField(max_length=16, unique=True)
    name = models.CharField(max_length=200)
    start_hour = models.PositiveSmallIntegerField(default=9)
    end_hour = models.PositiveSmallIntegerField(default=17)
    days = models.JSONField(default=list)
    mode = models.CharField(max_length=16, choices=MODE_CHOICES, default="inperson")
    location = models.CharField(max_length=500, blank=True, default="")
    organizer = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="organized_events",
    )
    participant_view_permission = models.CharField(
        max_length=16,
        choices=VIEW_PERMISSION_CHOICES,
        default="own_only",
    )
    day_selection_type = models.CharField(
        max_length=16,
        choices=DAY_SELECTION_CHOICES,
        default="days_of_week",
    )
    specific_dates = models.JSONField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.name} ({self.code})"


class Participant(TimestampedModel):
    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="participants")
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="schedule_participations",
    )
    participant_name = models.CharField(max_length=100)
    schedule_inperson = models.TextField()
    schedule_virtual = models.TextField()
    submitted = models.BooleanField(default=False)
    hidden = models.BooleanField(default=False)
    group_name = models.CharField(max_length=100, null=True, blank=True)
    sort_order = models.IntegerField(null=True, blank=True)

    class Meta:
        ordering = ["sort_order", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["event", "member"], name="one_participant_per_member_event"
            )
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
            )
        ]

    def __str__(self) -> str:
        return f"{self.event.code} / {self.participant.participant_name}: {self.weight}"


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
