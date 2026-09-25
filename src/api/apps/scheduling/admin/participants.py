"""Admin for participants, invitations, weights, and memberships."""

from django import forms
from django.contrib import admin
from django.core.exceptions import ValidationError
from unfold.admin import ModelAdmin

from apps.scheduling.models import (
    EventInvitation,
    Participant,
    ParticipantGroup,
    TemporaryEventSession,
    UserEvent,
    Weight,
)
from apps.scheduling.services.roster_groups import validate_group_name
from apps.scheduling.services.roster_imports.errors import RosterImportError


class ParticipantGroupAdminForm(forms.ModelForm):
    """Staff edits obey the cell grammar: a name holds no separator and is never ALL."""

    class Meta:
        model = ParticipantGroup
        fields = ("event", "name")

    def clean_name(self):
        try:
            return validate_group_name(self.cleaned_data.get("name"))
        except RosterImportError as exc:
            raise ValidationError(str(exc)) from exc


@admin.register(ParticipantGroup)
class ParticipantGroupAdmin(ModelAdmin):
    form = ParticipantGroupAdminForm
    list_display = ("name", "event", "member_count", "created_at")
    search_fields = ("name", "event__code", "event__name")

    @admin.display(description="Members")
    def member_count(self, group):
        return group.participants.count()


@admin.register(Participant)
class ParticipantAdmin(ModelAdmin):
    list_display = (
        "participant_name",
        "event",
        "member",
        "submitted",
        "hidden",
        "group_names",
        "all_groups",
        "sort_order",
    )
    list_filter = ("submitted", "hidden", "all_groups", "organizer_managed")
    search_fields = (
        "participant_name",
        "event__code",
        "event__name",
        "member__first_name",
        "member__last_name",
        "groups__name",
    )
    filter_horizontal = ("groups",)
    # Staff must not reopen a response the person already owns.
    readonly_fields = ("response_claimed_at",)

    def get_queryset(self, request):
        return super().get_queryset(request).prefetch_related("groups")

    def get_form(self, request, obj=None, **kwargs):
        # Remembered for formfield_for_manytomany, which only receives the request.
        request._participant_admin_obj = obj
        return super().get_form(request, obj, **kwargs)

    def formfield_for_manytomany(self, db_field, request, **kwargs):
        if db_field.name == "groups":
            # Only the participant's own event has groups they can belong to.
            participant = getattr(request, "_participant_admin_obj", None)
            kwargs["queryset"] = ParticipantGroup.objects.filter(
                event_id=participant.event_id if participant is not None else None
            )
        return super().formfield_for_manytomany(db_field, request, **kwargs)

    @admin.display(description="Groups")
    def group_names(self, participant):
        return "; ".join(group.name for group in participant.groups.all())


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
