"""Admin for schedule edit records and result snapshots."""

from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.scheduling.models import EventResultSnapshot, ScheduleEditRecord


@admin.register(ScheduleEditRecord)
class ScheduleEditRecordAdmin(ModelAdmin):
    list_display = (
        "event",
        "participant",
        "source",
        "action",
        "actor",
        "actor_identifier",
        "created_at",
    )
    list_filter = ("source", "action")
    search_fields = ("event__code", "participant__participant_name", "actor__email")


@admin.register(EventResultSnapshot)
class EventResultSnapshotAdmin(ModelAdmin):
    list_display = ("event", "status", "requested_revision", "computed_revision", "completed_at")
    list_filter = ("status",)
    search_fields = ("event__code",)
