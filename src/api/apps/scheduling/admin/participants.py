from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.scheduling.models import Participant, ScheduleEditRecord, UserEvent, Weight


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


@admin.register(Weight)
class WeightAdmin(ModelAdmin):
    list_display = ("event", "participant", "weight", "included")
    list_filter = ("included",)
    search_fields = ("event__code", "participant__participant_name")


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


@admin.register(UserEvent)
class UserEventAdmin(ModelAdmin):
    list_display = ("member", "event", "role", "created_at")
    list_filter = ("role",)
    search_fields = ("member__first_name", "member__last_name", "event__code", "event__name")
