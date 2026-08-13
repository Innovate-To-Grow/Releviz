from django import forms
from django.contrib import admin, messages
from django.core.cache import cache
from django.http import HttpResponseRedirect
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from unfold.decorators import action, display
from unfold.widgets import UnfoldAdminPasswordWidget

from apps.core.models import AWSCredentialConfig

from ..common.base import BaseModelAdmin


class AWSCredentialConfigForm(forms.ModelForm):
    secret_access_key = forms.CharField(
        required=False,
        widget=UnfoldAdminPasswordWidget(
            attrs={"autocomplete": "new-password"},
            render_value=False,
        ),
        help_text="Leave blank to keep the existing AWS secret access key.",
    )

    class Meta:
        model = AWSCredentialConfig
        fields = (
            "name",
            "is_active",
            "access_key_id",
            "default_region",
            "secret_access_key",
        )

    def save(self, commit=True):
        instance = super().save(commit=False)
        secret_access_key = self.cleaned_data.get("secret_access_key", "")
        if secret_access_key:
            instance.set_secret_access_key(secret_access_key)
        if commit:
            instance.save()
            self.save_m2m()
        return instance


def _clear_usage_dashboard_cache():
    cache.delete("assistant:usage:cloudwatch")
    cache.delete("assistant:usage:local")


@admin.register(AWSCredentialConfig)
class AWSCredentialConfigAdmin(BaseModelAdmin):
    form = AWSCredentialConfigForm
    list_display = (
        "name",
        "status_badge",
        "configured_badge",
        "access_key_masked",
        "default_region",
        "updated_at",
    )
    list_filter = ("is_active",)
    search_fields = ("name", "access_key_id")
    ordering = ("-is_active", "-updated_at")
    actions_detail = ["activate_this_config"]

    fieldsets = (
        (
            None,
            {"fields": ("name", "is_active")},
        ),
        (
            _("AWS Credentials"),
            {
                "fields": ("access_key_id", "secret_access_key", "default_region"),
                "description": "IAM access key and AWS region used by AWS-backed services.",
            },
        ),
        (_("Info"), {"fields": ("encrypted_secret_access_key", "updated_at")}),
    )
    readonly_fields = ("encrypted_secret_access_key", "updated_at")

    @display(description="Status", label=True)
    def status_badge(self, obj):
        if obj.is_active:
            return "Active", "success"
        return "Inactive", "danger"

    @display(description="Configured", label=True)
    def configured_badge(self, obj):
        if obj.is_configured:
            return "Yes", "success"
        return "No", "warning"

    @display(description="Access Key ID")
    def access_key_masked(self, obj):
        if obj.access_key_id:
            return f"...{obj.access_key_id[-4:]}"
        return "—"

    @action(description="Activate this config", url_path="activate", icon="check_circle")
    def activate_this_config(self, request, object_id):
        obj = AWSCredentialConfig.objects.get(pk=object_id)
        obj.is_active = True
        obj.save()
        _clear_usage_dashboard_cache()
        messages.success(request, f'"{obj.name}" is now the active AWS credential config.')
        change_url = reverse("admin:core_awscredentialconfig_change", args=[object_id])
        return HttpResponseRedirect(change_url)

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        _clear_usage_dashboard_cache()

    def has_delete_permission(self, request, obj=None):
        if obj is not None and obj.is_active:
            return False
        return super().has_delete_permission(request, obj)

    def get_actions(self, request):
        actions = super().get_actions(request)
        actions.pop("delete_selected", None)
        return actions
