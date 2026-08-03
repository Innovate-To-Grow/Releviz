from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.scheduling.models import (
    Event,
    EventDeletionRecord,
    EventDuplicationRequest,
    EventInvitation,
    FinalizationRequest,
    FinalMeeting,
    Participant,
    TemporaryEventSession,
    UserEvent,
    Weight,
)


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
        "response_deadline",
        "created_at",
    )
    list_filter = (
        "status",
        "mode",
        "timezone",
        "participant_view_permission",
        "day_selection_type",
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


@admin.register(Participant)
class ParticipantAdmin(ModelAdmin):
    list_display = (
        "participant_name",
        "event",
        "member",
        "submitted",
        "hidden",
        "group_name",
        "sort_order",
    )
    list_filter = ("submitted", "hidden", "group_name")
    search_fields = (
        "participant_name",
        "event__code",
        "event__name",
        "member__first_name",
        "member__last_name",
    )


@admin.register(EventInvitation)
class EventInvitationAdmin(ModelAdmin):
    list_display = (
        "email",
        "event",
        "member",
        "status",
        "last_sent_at",
        "opened_at",
        "joined_at",
        "draft_saved_at",
        "submitted_at",
        "reminder_sent_at",
    )
    list_filter = ("status", "event__mode")
    readonly_fields = ("access_token",)
    search_fields = (
        "email",
        "event__code",
        "event__name",
        "member__first_name",
        "member__last_name",
    )


@admin.register(Weight)
class WeightAdmin(ModelAdmin):
    list_display = ("event", "participant", "weight", "included", "required")
    list_filter = ("included", "required")
    search_fields = ("event__code", "participant__participant_name")


@admin.register(FinalMeeting)
class FinalMeetingAdmin(ModelAdmin):
    list_display = (
        "event",
        "starts_at",
        "ends_at",
        "timezone",
        "channel",
        "active",
        "calendar_sequence",
    )
    list_filter = ("active", "channel", "timezone")
    search_fields = ("event__code", "event__name", "calendar_uid", "location")
    readonly_fields = (
        "event",
        "starts_at",
        "ends_at",
        "timezone",
        "channel",
        "location",
        "calendar_uid",
        "calendar_sequence",
        "attendance_snapshot",
        "confirmed_by",
        "confirmed_at",
        "active",
        "canceled_at",
        "created_at",
        "updated_at",
    )


@admin.register(FinalizationRequest)
class FinalizationRequestAdmin(ModelAdmin):
    list_display = (
        "event",
        "idempotency_key",
        "meeting_sequence",
        "resulting_event_version",
        "created_at",
    )
    search_fields = ("event__code", "idempotency_key", "request_fingerprint")
    readonly_fields = (
        "event",
        "final_meeting",
        "idempotency_key",
        "request_fingerprint",
        "meeting_sequence",
        "resulting_event_version",
        "created_at",
        "updated_at",
    )


@admin.register(UserEvent)
class UserEventAdmin(ModelAdmin):
    list_display = ("member", "event", "role", "created_at")
    list_filter = ("role",)
    search_fields = ("member__first_name", "member__last_name", "event__code", "event__name")


@admin.register(TemporaryEventSession)
class TemporaryEventSessionAdmin(ModelAdmin):
    list_display = (
        "member",
        "participant",
        "invitation",
        "created_at",
        "expires_at",
        "last_seen_at",
        "revoked_at",
    )
    list_filter = ("revoked_at", "expires_at")
    search_fields = (
        "member__email",
        "participant__participant_name",
        "participant__event__code",
        "invitation__email",
    )
    readonly_fields = (
        "member",
        "participant",
        "invitation",
        "secret_hash",
        "expires_at",
        "last_seen_at",
        "revoked_at",
        "ip_address",
        "user_agent",
        "created_at",
        "updated_at",
    )
