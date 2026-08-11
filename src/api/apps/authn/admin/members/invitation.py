"""
Admin configuration for AdminInvitation model.
"""

import logging

from django.contrib import admin, messages
from django.utils import timezone
from django.utils.html import format_html

from apps.authn.models import AdminInvitation
from apps.core.admin import BaseModelAdmin

logger = logging.getLogger(__name__)


@admin.register(AdminInvitation)
class AdminInvitationAdmin(BaseModelAdmin):
    list_display = ["email", "role", "status_badge", "invited_by", "created_at", "expires_at"]
    list_filter = ["status", "role"]
    search_fields = ["email"]
    readonly_fields = [
        "token",
        "status",
        "invited_by",
        "accepted_by",
        "expires_at",
        "accepted_at",
        "created_at",
        "updated_at",
    ]
    actions = ["resend_invitations", "cancel_invitations"]

    # noinspection PyUnusedLocal
    def get_fieldsets(self, request, obj=None):
        if obj is None:
            return [
                (None, {"fields": ("email", "role", "message")}),
            ]
        return [
            (None, {"fields": ("email", "role", "status", "message")}),
            ("Details", {"fields": ("token", "invited_by", "accepted_by", "expires_at", "accepted_at")}),
            ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
        ]

    # noinspection PyUnusedLocal
    def get_readonly_fields(self, request, obj=None):
        if obj is not None:
            return self.readonly_fields + ["email", "role", "message"]
        return self.readonly_fields

    @admin.display(description="Status")
    def status_badge(self, obj):
        colors = {
            AdminInvitation.Status.PENDING: "#f59e0b",
            AdminInvitation.Status.ACCEPTED: "#10b981",
            AdminInvitation.Status.EXPIRED: "#6b7280",
            AdminInvitation.Status.CANCELLED: "#ef4444",
        }
        # Show expired badge for pending invitations that have expired
        status = obj.status
        if status == AdminInvitation.Status.PENDING and obj.is_expired:
            status = AdminInvitation.Status.EXPIRED
        color = colors.get(status, "#6b7280")
        label = AdminInvitation.Status(status).label if status != obj.status else obj.get_status_display()
        return format_html(
            '<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;color:#fff;background:{};">{}</span>',
            color,
            label,
        )

    def save_model(self, request, obj, form, change):
        obj.email = (obj.email or "").strip().lower()
        if not change:
            obj.token = AdminInvitation.generate_token()
            obj.invited_by = request.user
            obj.expires_at = AdminInvitation.default_expiry()

            # Cancel previous pending invitations for the same email
            AdminInvitation.objects.filter(
                email__iexact=obj.email,
                status=AdminInvitation.Status.PENDING,
            ).update(status=AdminInvitation.Status.CANCELLED, updated_at=timezone.now())

            super().save_model(request, obj, form, change)
            self._send_invitation_message(request, obj, created=True)
        else:
            super().save_model(request, obj, form, change)

    def _send_invitation_message(self, request, invitation, *, created=False, show_success=True):
        from apps.authn.services.email import send_admin_invitation_email

        try:
            send_admin_invitation_email(invitation=invitation, request=request)
        except Exception:
            logger.exception("Failed to send admin invitation email for %s", invitation.email)
            created_text = "created, but " if created else ""
            messages.error(
                request,
                (
                    f"Invitation {created_text}email could not be sent to {invitation.email}. "
                    f"Copy the invitation link manually: {invitation.get_acceptance_url(request)}"
                ),
            )
            return False

        if show_success:
            verb = "created and sent" if created else "resent"
            messages.success(request, f"Invitation {verb} for {invitation.email}.")
        return True

    @admin.action(description="Resend selected pending invitations")
    def resend_invitations(self, request, queryset):
        sent = 0
        skipped = 0

        for invitation in queryset:
            if not invitation.is_valid:
                if invitation.status == AdminInvitation.Status.PENDING and invitation.is_expired:
                    invitation.mark_expired()
                skipped += 1
                continue

            if self._send_invitation_message(request, invitation, show_success=False):
                sent += 1

        if skipped:
            messages.warning(request, f"Skipped {skipped} invalid, expired, or already-used invitation(s).")
        if sent:
            messages.success(request, f"Resent {sent} invitation email(s).")

    @admin.action(description="Cancel selected invitations")
    def cancel_invitations(self, request, queryset):
        count = queryset.filter(status=AdminInvitation.Status.PENDING).update(
            status=AdminInvitation.Status.CANCELLED,
            updated_at=timezone.now(),
        )
        messages.success(request, f"Cancelled {count} invitation(s).")
