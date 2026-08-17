"""Admin for events and their duplication/deletion records."""

from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.scheduling.models import Event, EventDeletionRecord, EventDuplicationRequest


@admin.register(Event)
class EventAdmin(ModelAdmin):
    list_display = (
        "code",
        "name",
        "organizer",
        "mode",
        "timezone",
        "status",
        "start_minutes",
        "end_minutes",
        "slot_minutes",
        "meeting_duration_minutes",
        "access_mode",
        "results_revision",
        "response_deadline",
        "created_at",
    )
    list_filter = (
        "status",
        "mode",
        "timezone",
        "participant_view_permission",
        "day_selection_type",
        "access_mode",
        "reminders_enabled",
    )
    search_fields = ("code", "name", "organizer__first_name", "organizer__last_name")


@admin.register(EventDuplicationRequest)
class EventDuplicationRequestAdmin(ModelAdmin):
    list_display = (
        "source_event",
        "duplicate_event",
        "requested_by",
        "source_version",
        "created_at",
    )
    search_fields = (
        "source_event__code",
        "duplicate_event__code",
        "requested_by__email",
        "idempotency_key",
    )
    readonly_fields = (
        "source_event",
        "duplicate_event",
        "requested_by",
        "idempotency_key",
        "request_fingerprint",
        "source_version",
        "created_at",
        "updated_at",
    )


@admin.register(EventDeletionRecord)
class EventDeletionRecordAdmin(ModelAdmin):
    list_display = ("code", "organizer", "deleted_version", "created_at")
    search_fields = ("code", "event_id", "organizer__email", "idempotency_key")
    readonly_fields = (
        "event_id",
        "code",
        "organizer",
        "idempotency_key",
        "request_fingerprint",
        "deleted_version",
        "created_at",
        "updated_at",
    )
