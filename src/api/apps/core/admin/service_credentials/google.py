from django import forms
from django.contrib import admin, messages
from django.http import HttpResponseRedirect
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from unfold.decorators import action, display
from unfold.widgets import UnfoldAdminFileFieldWidget, UnfoldAdminTextareaWidget

from apps.core.models import GoogleCredentialConfig

from ..common.base import BaseModelAdmin


class GoogleCredentialConfigForm(forms.ModelForm):
    credentials_file = forms.FileField(
        required=False,
        label="Upload JSON Key File",
        help_text="Upload a Google service-account JSON key file. This will overwrite the current credentials.",
        widget=UnfoldAdminFileFieldWidget(attrs={"accept": ".json"}),
    )

    class Meta:
        model = GoogleCredentialConfig
        fields = "__all__"
        widgets = {
            "credentials_json": UnfoldAdminTextareaWidget(attrs={"rows": 12}),
        }

    def clean_credentials_file(self):
        f = self.cleaned_data.get("credentials_file")
        if f:
            import json

            try:
                data = json.load(f)
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise forms.ValidationError(f"Invalid JSON file: {exc}")
            if not isinstance(data, dict):
                raise forms.ValidationError("JSON file must contain an object, not a list or scalar.")
            return data
        return None

    def clean(self):
        cleaned = super().clean()
        file_data = cleaned.get("credentials_file")
        if file_data:
            cleaned["credentials_json"] = file_data
        return cleaned


@admin.register(GoogleCredentialConfig)
class GoogleCredentialConfigAdmin(BaseModelAdmin):
    form = GoogleCredentialConfigForm
    list_display = ("name", "status_badge", "project_id_display", "client_email_display", "updated_at")
    list_filter = ("is_active",)
    search_fields = ("name",)
    ordering = ("-is_active", "-updated_at")
    actions_detail = ["activate_this_config"]

    fieldsets = (
        (
            None,
            {"fields": ("name", "is_active")},
        ),
        (
            _("Service Account Credentials"),
            {
                "fields": ("credentials_file", "credentials_json"),
                "description": "Upload the JSON key file or paste its contents directly.",
            },
        ),
        (_("Info"), {"fields": ("updated_at",)}),
    )
    readonly_fields = ("updated_at",)

    @display(description="Status", label=True)
    def status_badge(self, obj):
        if obj.is_active:
            return "Active", "success"
        return "Inactive", "danger"

    @display(description="Project ID")
    def project_id_display(self, obj):
        return obj.project_id or "—"

    @display(description="Client Email")
    def client_email_display(self, obj):
        return obj.client_email or "—"

    @action(description="Activate this config", url_path="activate", icon="check_circle")
    def activate_this_config(self, request, object_id):
        obj = GoogleCredentialConfig.objects.get(pk=object_id)
        obj.is_active = True
        obj.save()
        messages.success(request, f'"{obj.name}" is now the active Google credential config.')
        return HttpResponseRedirect(reverse("admin:core_googlecredentialconfig_change", args=[object_id]))

    # noinspection PyUnusedLocal,PyMethodMayBeStatic
    def has_delete_permission(self, request, obj=None):
        if obj is not None and obj.is_active:
            return False
        return super().has_delete_permission(request, obj)

    def get_actions(self, request):
        actions = super().get_actions(request)
        actions.pop("delete_selected", None)
        return actions
