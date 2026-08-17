"""Event configuration and the audit records for duplicating or deleting one."""

import uuid

from django.conf import settings
from django.db import models
from django.db.models.functions import Mod
from django.db.models.lookups import Exact

from apps.core.models import TimestampedModel
from apps.scheduling.validators import validate_iana_timezone


def default_weekdays():
    return [1, 2, 3, 4, 5]


class Event(TimestampedModel):
    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
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
    ACCESS_MODE_CHOICES = [
        ("invite_only", "Invite only"),
        ("open_link", "Open link"),
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
    access_mode = models.CharField(
        max_length=16,
        choices=ACCESS_MODE_CHOICES,
        default="invite_only",
    )
    meeting_duration_minutes = models.PositiveSmallIntegerField(default=30)
    results_revision = models.PositiveBigIntegerField(default=1)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    version = models.PositiveBigIntegerField(default=1)
    opened_at = models.DateTimeField(null=True, blank=True)
    finalized_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=["active", "finalized", "closed", "archived"]),
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
            models.CheckConstraint(
                condition=models.Q(access_mode__in=["invite_only", "open_link"]),
                name="event_access_mode_is_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    meeting_duration_minutes__gte=15,
                    meeting_duration_minutes__lte=480,
                ),
                name="event_meeting_duration_in_range",
            ),
            models.CheckConstraint(
                condition=Exact(
                    Mod(
                        models.F("meeting_duration_minutes"),
                        models.F("slot_minutes"),
                    ),
                    0,
                ),
                name="event_meeting_duration_aligns_to_slot",
            ),
            models.CheckConstraint(
                condition=models.Q(results_revision__gte=1),
                name="event_results_revision_is_positive",
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
