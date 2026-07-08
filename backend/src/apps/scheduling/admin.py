from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.scheduling.models import Event, EventInvitation, Participant, UserEvent, Weight


@admin.register(Event)
class EventAdmin(ModelAdmin):
    list_display = (
        "code",
        "name",
        "organizer",
        "mode",
        "start_hour",
        "end_hour",
        "response_deadline",
        "created_at",
    )
    list_filter = ("mode", "participant_view_permission", "day_selection_type", "reminders_enabled")
    search_fields = ("code", "name", "organizer__first_name", "organizer__last_name")


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
    list_display = ("email", "event", "member", "status", "last_sent_at", "reminder_sent_at")
    list_filter = ("status", "event__mode")
    search_fields = (
        "email",
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


@admin.register(UserEvent)
class UserEventAdmin(ModelAdmin):
    list_display = ("member", "event", "role", "created_at")
    list_filter = ("role",)
    search_fields = ("member__first_name", "member__last_name", "event__code", "event__name")
