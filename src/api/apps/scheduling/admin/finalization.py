from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.scheduling.models import FinalizationRequest, FinalMeeting


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
