"""Admin for participants, invitations, weights, and memberships."""

from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.scheduling.models import (
    EventInvitation,
    Participant,
    TemporaryEventSession,
    UserEvent,
    Weight,
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
    list_display = ("event", "participant", "weight", "included")
    list_filter = ("included",)
    search_fields = ("event__code", "participant__participant_name")


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
