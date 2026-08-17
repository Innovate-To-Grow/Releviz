from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.scheduling.models import EventInvitation, TemporaryEventSession


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
