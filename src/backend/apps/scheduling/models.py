import uuid

from django.conf import settings
from django.db import models

from apps.core.models import TimestampedModel
from apps.scheduling.validators import validate_iana_timezone


def default_weekdays():
    return [1, 2, 3, 4, 5]


class Event(TimestampedModel):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        OPEN = "open", "Open"
        FINALIZED = "finalized", "Finalized"
        CLOSED = "closed", "Closed"
        ARCHIVED = "archived", "Archived"

    MODE_CHOICES = [
        ("inperson", "In person"),
        ("virtual", "Virtual"),
        ("mixed", "Mixed"),
    ]
    VIEW_PERMISSION_CHOICES = [
        ("own_only", "Own only"),
        ("all_after_submit", "All after submit"),
        ("realtime", "Realtime"),
    ]
    DAY_SELECTION_CHOICES = [
        ("days_of_week", "Days of week"),
        ("specific_dates", "Specific dates"),
    ]

    event_id = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    code = models.CharField(max_length=16, unique=True)
    name = models.CharField(max_length=200)
    start_minutes = models.PositiveSmallIntegerField(default=9 * 60)
    end_minutes = models.PositiveSmallIntegerField(default=17 * 60)
    slot_minutes = models.PositiveSmallIntegerField(
        choices=[(15, "15 minutes"), (30, "30 minutes")],
        default=30,
    )
    spans_next_day = models.BooleanField(default=False)
    days = models.JSONField(default=default_weekdays)
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
    response_deadline = models.DateTimeField(null=True, blank=True)
    timezone = models.CharField(
        max_length=64,
        default="UTC",
        validators=[validate_iana_timezone],
    )
    reminders_enabled = models.BooleanField(default=True)
    reminder_hours_before = models.PositiveSmallIntegerField(default=24)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.OPEN)
    version = models.PositiveBigIntegerField(default=1)
    opened_at = models.DateTimeField(null=True, blank=True)
    finalized_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=["draft", "open", "finalized", "closed", "archived"]),
                name="event_status_is_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(version__gte=1),
                name="event_version_is_positive",
            ),
            models.CheckConstraint(
                condition=models.Q(start_minutes__gte=0, start_minutes__lt=24 * 60),
                name="event_start_minutes_in_day",
            ),
            models.CheckConstraint(
                condition=models.Q(end_minutes__gte=0, end_minutes__lt=24 * 60),
                name="event_end_minutes_in_day",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(spans_next_day=True)
                    & models.Q(end_minutes__lte=models.F("start_minutes"))
                )
                | (
                    models.Q(spans_next_day=False)
                    & models.Q(end_minutes__gt=models.F("start_minutes"))
                ),
                name="event_window_direction_is_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(slot_minutes__in=[15, 30]),
                name="event_slot_minutes_supported",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.code})"


class EventDuplicationRequest(TimestampedModel):
    source_event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="duplication_requests",
    )
    duplicate_event = models.ForeignKey(
        Event,
        on_delete=models.SET_NULL,
        null=True,
        related_name="source_duplication_requests",
    )
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="event_duplication_requests",
    )
    idempotency_key = models.UUIDField()
    request_fingerprint = models.CharField(max_length=64)
    source_version = models.PositiveBigIntegerField()

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["source_event", "idempotency_key"],
                name="one_event_duplication_per_key",
            ),
            models.CheckConstraint(
                condition=models.Q(source_version__gte=1),
                name="event_duplication_source_version_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.source_event.code} / {self.idempotency_key}"


class EventDeletionRecord(TimestampedModel):
    event_id = models.UUIDField(unique=True)
    code = models.CharField(max_length=16, unique=True)
    organizer = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="event_deletion_records",
    )
    idempotency_key = models.UUIDField()
    request_fingerprint = models.CharField(max_length=64)
    deleted_version = models.PositiveBigIntegerField()

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["organizer", "idempotency_key"],
                name="one_event_deletion_per_member_key",
            ),
            models.CheckConstraint(
                condition=models.Q(deleted_version__gte=1),
                name="event_deletion_version_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} deleted at version {self.deleted_version}"


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


class EventInvitation(TimestampedModel):
    class Status(models.TextChoices):
        INVITED = "invited", "Invited"
        OPENED = "opened", "Opened"
        JOINED = "joined", "Joined"
        DRAFT_SAVED = "draft_saved", "Draft saved"
        SUBMITTED = "submitted", "Submitted"

    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="invitations")
    email = models.EmailField()
    access_token = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="event_invitations",
    )
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sent_event_invitations",
    )
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.INVITED)
    first_sent_at = models.DateTimeField(null=True, blank=True)
    last_sent_at = models.DateTimeField(null=True, blank=True)
    reminder_sent_at = models.DateTimeField(null=True, blank=True)
    accepted_at = models.DateTimeField(null=True, blank=True)
    opened_at = models.DateTimeField(null=True, blank=True)
    joined_at = models.DateTimeField(null=True, blank=True)
    draft_saved_at = models.DateTimeField(null=True, blank=True)
    submitted_at = models.DateTimeField(null=True, blank=True)
    custom_message = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["email"]
        constraints = [
            models.UniqueConstraint(
                fields=["event", "email"],
                name="one_invitation_per_event_email",
            )
        ]
        indexes = [
            models.Index(fields=["email"]),
            models.Index(fields=["status"]),
            models.Index(fields=["first_sent_at"]),
            models.Index(fields=["last_sent_at"]),
            models.Index(fields=["reminder_sent_at"]),
        ]

    def save(self, *args, **kwargs):
        self.email = self.email.strip().lower()
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return f"{self.email} invited to {self.event.code} [{self.status}]"


class Weight(TimestampedModel):
    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="weights")
    participant = models.ForeignKey(Participant, on_delete=models.CASCADE, related_name="weights")
    weight = models.FloatField(default=1.0)
    included = models.BooleanField(default=True)
    required = models.BooleanField(default=False)

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
