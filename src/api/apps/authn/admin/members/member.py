"""
Member admin configuration.
"""

import logging
import uuid

from django.conf import settings
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin
from django.core.exceptions import PermissionDenied
from django.shortcuts import get_object_or_404, redirect
from django.urls import path
from django.utils.translation import gettext_lazy as _
from unfold.forms import AdminPasswordChangeForm

from apps.core.admin import BaseModelAdmin

from ...models import ImpersonationToken, Member
from .forms import MemberChangeForm, MemberCreationForm
from .helpers import (
    activate_members,
    deactivate_members,
    download_template_view,
    export_excel_view,
    export_members_response,
    export_members_vcard_response,
    get_full_name_display,
    get_primary_email_display,
    import_excel_view,
    normalize_inline_uuid_none_values,
)
from .inlines import ContactEmailInline

logger = logging.getLogger(__name__)


@admin.register(Member)
class MemberAdmin(BaseModelAdmin, UserAdmin):
    """Custom admin for Member with profile, contact, import, and export tooling."""

    def get_queryset(self, request):
        qs = super().get_queryset(request)
        return qs.prefetch_related("contact_emails")

    form = MemberChangeForm
    add_form = MemberCreationForm
    # Django's default AdminPasswordChangeForm does not apply Unfold INPUT_CLASSES;
    # password fields render with no visible borders on the themed admin page.
    change_password_form = AdminPasswordChangeForm
    change_form_template = "admin/authn/member/change_form.html"
    list_display = (
        "get_full_name_display",
        "get_primary_email_display",
        "organization",
        "is_active",
        "is_staff",
        "date_joined",
    )
    list_filter = ("is_active", "is_staff", "date_joined")
    search_fields = (
        "contact_emails__email_address",
        "first_name",
        "middle_name",
        "last_name",
        "id",
        "organization",
        "title",
    )
    ordering = ("-date_joined",)
    readonly_fields = ("member_uuid", "date_joined", "last_login")
    fieldsets = (
        (_("Member Info"), {"fields": ("member_uuid",)}),
        (None, {"fields": ("password",)}),
        (
            _("Personal Info"),
            {"fields": ("first_name", "middle_name", "last_name", "organization", "title", "profile_image")},
        ),
        (
            _("Permissions"),
            {
                "fields": ("is_active", "is_staff", "admin_apps"),
                "classes": ("collapse",),
            },
        ),
        (_("Important Dates"), {"fields": ("last_login", "date_joined"), "classes": ("collapse",)}),
    )
    add_fieldsets = (
        (None, {"classes": ("wide",), "fields": ("password1", "password2")}),
        (_("Personal Info"), {"fields": ("first_name", "middle_name", "last_name", "organization", "title")}),
        (_("Member Status"), {"fields": ("is_active",)}),
    )
    inlines = [ContactEmailInline]
    change_list_template = "admin/authn/member/change_list.html"
    actions = [
        "activate_members",
        "deactivate_members",
        "export_members_to_excel",
        "export_members_to_vcard",
    ]
    actions_no_confirmation = ["export_members_to_excel", "export_members_to_vcard"]

    @admin.display(description="Primary Email")
    def get_primary_email_display(self, obj):
        return get_primary_email_display(obj)

    @admin.display(description="Full Name")
    def get_full_name_display(self, obj):
        return get_full_name_display(obj)

    @admin.action(description="Activate selected members")
    def activate_members(self, request, queryset):
        activate_members(self, request, queryset)

    @admin.action(description="Deactivate selected members")
    def deactivate_members(self, request, queryset):
        deactivate_members(self, request, queryset)

    @admin.action(description="Export selected members to Excel")
    def export_members_to_excel(self, request, queryset):
        return export_members_response(queryset)

    @admin.action(description="Export selected members as vCard (.vcf)")
    def export_members_to_vcard(self, request, queryset):
        return export_members_vcard_response(queryset)

    def get_urls(self):
        custom_urls = [
            path("import-excel/", self.admin_site.admin_view(self.import_excel_view), name="authn_member_import_excel"),
            path(
                "import-template/",
                self.admin_site.admin_view(self.download_template_view),
                name="authn_member_import_template",
            ),
            path("export-excel/", self.admin_site.admin_view(self.export_excel_view), name="authn_member_export_excel"),
            path(
                "<path:object_id>/impersonate/",
                self.admin_site.admin_view(self.impersonate_view),
                name="authn_member_impersonate",
            ),
        ]
        return custom_urls + super().get_urls()

    def impersonate_view(self, request, object_id):
        # ``admin_site.admin_view`` only enforces is_staff, so this custom URL must
        # re-check authorization itself (Django never runs the per-app model
        # permissions for a standalone admin view). Require authn-app access, and
        # never let a non-superuser account be impersonated into a privileged one:
        # impersonation is an end-user support tool, and minting a token for a
        # staff/superuser account would be a privilege-escalation vector.
        if not self.has_change_permission(request):
            raise PermissionDenied("You do not have permission to impersonate members.")
        member = get_object_or_404(Member, pk=object_id)
        if member.is_staff or member.is_superuser:
            raise PermissionDenied("Staff and superuser accounts cannot be impersonated.")
        token = ImpersonationToken.generate_token()
        ImpersonationToken.objects.create(token=token, member=member, created_by=request.user)
        logger.info("Administrator %s began impersonating member %s", request.user.id, member.id)
        frontend_url = (getattr(settings, "FRONTEND_URL", "") or "").strip().rstrip("/")
        return redirect(f"{frontend_url}/impersonate-login#token={token}")

    # Granting admin-app access or staff status is an I2G Master (superuser)
    # responsibility. A non-superuser admin must not be able to widen their own
    # (or anyone's) privileges by editing these fields, so they are read-only for
    # non-superusers — Django drops any submitted value for read-only fields, so
    # this is enforced server-side, not just hidden in the rendered form.
    superuser_only_fields = ("is_staff", "admin_apps")

    def get_readonly_fields(self, request, obj=None):
        readonly = list(super().get_readonly_fields(request, obj))
        if not request.user.is_superuser:
            for field in self.superuser_only_fields:
                if field not in readonly:
                    readonly.append(field)
        return readonly

    def get_search_results(self, request, queryset, search_term):
        """Run the default search (email/name/id/...)."""
        return super().get_search_results(request, queryset, search_term)

    def change_view(self, request, object_id, form_url="", extra_context=None):
        extra_context = extra_context or {}
        # Only surface the impersonate button when the request may actually use it
        # (authn-app access) and the target is a non-privileged account — mirrors
        # the authorization enforced in ``impersonate_view``.
        target = self.get_object(request, object_id)
        extra_context["show_impersonate"] = bool(
            self.has_change_permission(request, target)
            and target is not None
            and not (target.is_staff or target.is_superuser)
        )
        return super().change_view(request, object_id, form_url=form_url, extra_context=extra_context)

    def changeform_view(self, request, object_id=None, form_url="", extra_context=None):
        normalize_inline_uuid_none_values(request)
        return super().changeform_view(request, object_id=object_id, form_url=form_url, extra_context=extra_context)

    def save_form(self, request, form, change):
        obj = super().save_form(request, form, change)
        self._ensure_new_member_uuid(obj, change)
        return obj

    def save_model(self, request, obj, form, change):
        self._ensure_new_member_uuid(obj, change)
        super().save_model(request, obj, form, change)

    @staticmethod
    def _ensure_new_member_uuid(obj, change):
        if not change and getattr(obj, "id", None) in (None, "", "None"):
            obj.id = uuid.uuid4()

    def import_excel_view(self, request):
        return import_excel_view(self, request)

    def download_template_view(self, request):
        return download_template_view(self, request)

    def export_excel_view(self, request):
        return export_excel_view(self, request)
