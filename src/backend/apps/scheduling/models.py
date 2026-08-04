import uuid

from django.conf import settings
from django.db import models
from django.db.models.functions import Mod
from django.db.models.lookups import Exact
from django.utils import timezone

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
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.DRAFT)
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


class RosterImportBatch(TimestampedModel):
    class SourceType(models.TextChoices):
        CSV = "csv", "CSV upload"
        XLSX = "xlsx", "Excel upload"
        PASTE = "paste", "Pasted table"

    class Status(models.TextChoices):
        PREVIEW = "preview", "Preview"
        COMMITTING = "committing", "Committing"
        COMMITTED = "committed", "Committed"
        CANCELED = "canceled", "Canceled"
        EXPIRED = "expired", "Expired"
        FAILED = "failed", "Failed"

    event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="roster_import_batches",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="roster_import_batches",
    )
    source_type = models.CharField(max_length=16, choices=SourceType.choices)
    source_label = models.CharField(max_length=64, blank=True, default="")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PREVIEW)
    worksheets = models.JSONField(default=list)
    selected_worksheet = models.CharField(max_length=128, blank=True, default="")
    header_row = models.PositiveIntegerField(default=1)
    column_mapping = models.JSONField(default=dict)
    defaults = models.JSONField(default=dict)
    summary = models.JSONField(default=dict)
    expires_at = models.DateTimeField()
    failure_reason = models.CharField(max_length=500, blank=True, default="")

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["event", "status", "created_at"]),
            models.Index(fields=["status", "expires_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.event.code} roster import [{self.status}]"


class RosterImportRow(TimestampedModel):
    class DuplicateStatus(models.TextChoices):
        UNIQUE = "unique", "Unique"
        IDENTICAL = "identical", "Identical duplicate"
        CONFLICT = "conflict", "Conflicting duplicate"

    batch = models.ForeignKey(
        RosterImportBatch,
        on_delete=models.CASCADE,
        related_name="rows",
    )
    worksheet = models.CharField(max_length=128)
    row_number = models.PositiveIntegerField()
    raw_values = models.JSONField(default=list)
    name = models.CharField(max_length=100, blank=True, default="")
    email = models.EmailField(blank=True, default="")
    group_name = models.CharField(max_length=100, blank=True, default="")
    weight = models.FloatField(default=1.0)
    included = models.BooleanField(default=True)
    selected = models.BooleanField(default=False)
    validation_errors = models.JSONField(default=list)
    duplicate_status = models.CharField(
        max_length=16,
        choices=DuplicateStatus.choices,
        default=DuplicateStatus.UNIQUE,
    )

    class Meta:
        ordering = ["worksheet", "row_number"]
        constraints = [
            models.UniqueConstraint(
                fields=["batch", "worksheet", "row_number"],
                name="one_roster_import_row_position",
            ),
            models.CheckConstraint(
                condition=models.Q(weight__gte=0.0, weight__lte=1.0),
                name="roster_import_weight_in_range",
            ),
        ]
        indexes = [
            models.Index(fields=["batch", "worksheet", "row_number"]),
            models.Index(fields=["batch", "selected", "duplicate_status"]),
        ]

    def __str__(self) -> str:
        return f"{self.batch_id} / {self.worksheet}:{self.row_number}"


class RosterImportReceipt(TimestampedModel):
    class Mode(models.TextChoices):
        MERGE = "merge", "Merge"
        REBUILD = "rebuild", "Rebuild"

    event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="roster_import_receipts",
    )
    batch = models.OneToOneField(
        RosterImportBatch,
        on_delete=models.PROTECT,
        related_name="receipt",
    )
    committed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="roster_import_receipts",
    )
    idempotency_key = models.UUIDField()
    request_fingerprint = models.CharField(max_length=64)
    mode = models.CharField(max_length=16, choices=Mode.choices)
    imported_count = models.PositiveIntegerField(default=0)
    created_count = models.PositiveIntegerField(default=0)
    updated_count = models.PositiveIntegerField(default=0)
    results_revision = models.PositiveBigIntegerField()
    committed_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-committed_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["event", "idempotency_key"],
                name="one_roster_import_receipt_per_key",
            ),
            models.CheckConstraint(
                condition=models.Q(results_revision__gte=1),
                name="roster_receipt_results_revision_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.event.code} / {self.idempotency_key}"


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


class EventResultSnapshot(TimestampedModel):
    class Status(models.TextChoices):
        REFRESHING = "refreshing", "Refreshing"
        FRESH = "fresh", "Fresh"
        FAILED = "failed", "Failed"

    event = models.OneToOneField(
        Event,
        on_delete=models.CASCADE,
        related_name="result_snapshot",
    )
    requested_revision = models.PositiveBigIntegerField(default=1)
    computed_revision = models.PositiveBigIntegerField(default=0)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.REFRESHING,
    )
    payload = models.JSONField(default=dict)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")
    locked_at = models.DateTimeField(null=True, blank=True)
    lock_token = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(requested_revision__gte=0),
                name="result_snapshot_requested_revision_nonnegative",
            ),
            models.CheckConstraint(
                condition=models.Q(computed_revision__gte=0),
                name="result_snapshot_computed_revision_nonnegative",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "updated_at"]),
            models.Index(fields=["locked_at"]),
        ]

    def __str__(self) -> str:
        return (
            f"{self.event.code} results {self.computed_revision}/"
            f"{self.requested_revision} [{self.status}]"
        )


class EventResultInvalidation(TimestampedModel):
    """Durable, low-contention signal from a response write to the result worker."""

    event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="result_invalidations",
    )
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(
                fields=["event", "processed_at", "created_at"],
                name="result_inval_event_pending_idx",
            )
        ]

    def __str__(self) -> str:
        state = "processed" if self.processed_at else "pending"
        return f"{self.event.code} result invalidation [{state}]"


class RosterBulkUpdateReceipt(TimestampedModel):
    event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="roster_bulk_update_receipts",
    )
    idempotency_key = models.UUIDField()
    request_fingerprint = models.CharField(max_length=64)
    matched_count = models.PositiveIntegerField(default=0)
    updated_count = models.PositiveIntegerField(default=0)
    results_revision = models.PositiveBigIntegerField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["event", "idempotency_key"],
                name="one_roster_bulk_update_receipt_per_key",
            ),
            models.CheckConstraint(
                condition=models.Q(results_revision__gte=1),
                name="roster_bulk_receipt_revision_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.event.code} roster bulk / {self.idempotency_key}"


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


class TemporaryEventSession(TimestampedModel):
    """An opaque, event-scoped session for a temporary participant.

    This credential is deliberately separate from ``AuthSession`` and never
    produces a JWT. The browser cookie contains the session UUID and a random
    secret; only the SHA-256 digest of that secret is persisted.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="temporary_event_sessions",
    )
    participant = models.ForeignKey(
        Participant,
        on_delete=models.CASCADE,
        related_name="temporary_sessions",
    )
    invitation = models.ForeignKey(
        EventInvitation,
        on_delete=models.CASCADE,
        related_name="temporary_sessions",
    )
    secret_hash = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField()
    last_seen_at = models.DateTimeField(default=timezone.now)
    revoked_at = models.DateTimeField(null=True, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["member", "revoked_at", "expires_at"],
                name="tmp_session_member_exp_idx",
            ),
            models.Index(
                fields=["participant", "revoked_at", "expires_at"],
                name="tmp_session_part_exp_idx",
            ),
            models.Index(fields=["expires_at"], name="tmp_session_expires_idx"),
        ]

    @property
    def active(self) -> bool:
        return self.revoked_at is None and self.expires_at > timezone.now()

    def revoke(self) -> bool:
        if self.revoked_at is not None:
            return False
        self.revoked_at = timezone.now()
        self.save(update_fields=["revoked_at", "updated_at"])
        return True

    def __str__(self) -> str:
        state = "active" if self.active else "revoked/expired"
        return f"{self.member_id} / {self.participant.event.code} [{state}]"
