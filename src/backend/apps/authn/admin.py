from django.contrib import admin
from django.contrib.auth.admin import GroupAdmin
from django.contrib.auth.models import Group
from django.utils import timezone
from unfold.admin import ModelAdmin

from apps.authn.models import (
    AuthRateLimitBucket,
    AuthSession,
    ContactEmail,
    ContactPhone,
    EmailAuthChallenge,
    Member,
    RSAKeypair,
)

try:  # pragma: no branch
    admin.site.unregister(Group)
except admin.sites.NotRegistered:  # pragma: no cover
    pass
admin.site.register(Group, GroupAdmin)


class ContactEmailInline(admin.TabularInline):
    model = ContactEmail
    extra = 0
    fields = ("email_address", "email_type", "verified", "subscribe")


class ContactPhoneInline(admin.TabularInline):
    model = ContactPhone
    extra = 0
    fields = ("phone_number", "region", "verified", "subscribe")


@admin.register(Member)
class MemberAdmin(ModelAdmin):
    list_display = (
        "display_name",
        "primary_email",
        "access_level",
        "organization",
        "is_active",
        "is_staff",
        "date_joined",
    )
    list_filter = ("access_level", "is_active", "is_staff", "is_superuser")
    search_fields = (
        "first_name",
        "last_name",
        "email",
        "contact_emails__email_address",
        "organization",
    )
    readonly_fields = ("id", "date_joined", "last_login")
    inlines = [ContactEmailInline, ContactPhoneInline]
    fieldsets = (
        (
            "Identity",
            {
                "fields": (
                    "id",
                    "first_name",
                    "last_name",
                    "email",
                    "access_level",
                    "organization",
                    "title",
                )
            },
        ),
        (
            "Permissions",
            {
                "fields": (
                    "is_active",
                    "is_staff",
                    "is_superuser",
                    "groups",
                    "user_permissions",
                    "admin_apps",
                )
            },
        ),
        ("Dates", {"fields": ("last_login", "date_joined")}),
    )

    @admin.display(description="Name")
    def display_name(self, obj):
        return obj.display_name()

    @admin.display(description="Primary email")
    def primary_email(self, obj):
        return obj.get_primary_contact_email()


@admin.register(ContactEmail)
class ContactEmailAdmin(ModelAdmin):
    list_display = ("email_address", "member", "email_type", "verified", "subscribe", "created_at")
    list_filter = ("email_type", "verified", "subscribe")
    search_fields = ("email_address", "member__first_name", "member__last_name")


@admin.register(ContactPhone)
class ContactPhoneAdmin(ModelAdmin):
    list_display = ("phone_number", "region", "member", "verified", "subscribe", "created_at")
    list_filter = ("region", "verified", "subscribe")
    search_fields = ("phone_number", "member__first_name", "member__last_name")


@admin.register(EmailAuthChallenge)
class EmailAuthChallengeAdmin(ModelAdmin):
    list_display = (
        "purpose",
        "target_email",
        "target_phone",
        "scope_key",
        "member",
        "status",
        "expires_at",
        "created_at",
    )
    list_filter = ("purpose", "channel", "status")
    search_fields = (
        "target_email",
        "target_phone",
        "scope_key",
        "member__first_name",
        "member__last_name",
    )
    readonly_fields = ("code_hash", "verification_token_hash")


@admin.action(description="Revoke selected active sessions")
def revoke_selected_sessions(modeladmin, request, queryset):
    queryset.filter(revoked_at__isnull=True).update(
        revoked_at=timezone.now(),
        revoked_reason=AuthSession.RevocationReason.ADMIN,
        updated_at=timezone.now(),
    )


@admin.register(AuthSession)
class AuthSessionAdmin(ModelAdmin):
    list_display = (
        "member",
        "created_at",
        "last_seen_at",
        "expires_at",
        "revoked_at",
        "ip_address",
    )
    list_filter = ("revoked_reason", "revoked_at")
    search_fields = (
        "member__email",
        "member__contact_emails__email_address",
        "refresh_jti",
        "ip_address",
    )
    readonly_fields = (
        "member",
        "refresh_jti",
        "previous_refresh_jti",
        "refresh_recovery_expires_at",
        "refresh_recovered_at",
        "expires_at",
        "last_seen_at",
        "revoked_at",
        "revoked_reason",
        "ip_address",
        "user_agent",
        "created_at",
        "updated_at",
    )
    actions = [revoke_selected_sessions]


@admin.register(AuthRateLimitBucket)
class AuthRateLimitBucketAdmin(ModelAdmin):
    list_display = (
        "scope",
        "request_count",
        "window_started_at",
        "blocked_until",
        "updated_at",
    )
    list_filter = ("scope",)
    search_fields = ("scope", "key_hash")
    readonly_fields = (
        "scope",
        "key_hash",
        "request_count",
        "window_started_at",
        "blocked_until",
        "created_at",
        "updated_at",
    )


@admin.register(RSAKeypair)
class RSAKeypairAdmin(ModelAdmin):
    list_display = ("name", "key_id", "is_active", "rotated_at", "created_at")
    list_filter = ("is_active",)
    readonly_fields = ("key_id", "public_key_pem", "private_key_pem")
