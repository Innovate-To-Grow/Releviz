from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.scheduling.models import EventResultSnapshot


@admin.register(EventResultSnapshot)
class EventResultSnapshotAdmin(ModelAdmin):
    list_display = ("event", "status", "requested_revision", "computed_revision", "completed_at")
    list_filter = ("status",)
    search_fields = ("event__code",)
