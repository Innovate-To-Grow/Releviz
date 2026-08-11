from django import forms
from django.contrib import admin, messages
from django.core.cache import cache
from django.http import HttpResponseRedirect
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from unfold.decorators import action, display

from apps.core.models import AWSCredentialConfig

from ..common.base import BaseModelAdmin
from .test_send_mixin import TestSendViewsMixin


class AWSCredentialConfigForm(forms.ModelForm):
    secret_access_key = forms.CharField(
        required=False,
        widget=forms.PasswordInput(render_value=False),
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
        instance.set_secret_access_key(self.cleaned_data.get("secret_access_key", ""))
        if commit:
            instance.save()
            self.save_m2m()
        return instance


def _clear_usage_dashboard_cache():
    cache.delete("assistant:usage:cloudwatch")
    cache.delete("assistant:usage:local")


@admin.register(AWSCredentialConfig)
class AWSCredentialConfigAdmin(TestSendViewsMixin, BaseModelAdmin):
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
    actions_detail = ["activate_this_config", "test_bedrock_api"]
    actions_list = ["test_email_list"]

    fieldsets = (
        (
            None,
            {"fields": ("name", "is_active")},
        ),
        (
            _("AWS Credentials"),
            {
                "fields": ("access_key_id", "secret_access_key", "default_region"),
                "description": "Shared IAM access key and AWS region used by AWS-backed services.",
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
        return HttpResponseRedirect(reverse("admin:core_awscredentialconfig_change", args=[object_id]))

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        _clear_usage_dashboard_cache()

    @action(description="Test Bedrock API", url_path="test-bedrock", icon="science")
    def test_bedrock_api(self, request, object_id):
        """Send a minimal Converse call to verify credentials + model work."""
        import boto3
        from botocore.exceptions import ClientError

        obj = AWSCredentialConfig.objects.get(pk=object_id)
        change_url = reverse("admin:core_awscredentialconfig_change", args=[object_id])

        if not obj.is_configured:
            messages.error(request, "Cannot test: AWS credentials are not configured.")
            return HttpResponseRedirect(change_url)

        from apps.system_intelligence.models import SystemIntelligenceConfig

        model_id = SystemIntelligenceConfig.load().default_model_id
        if not model_id:
            messages.error(request, "Cannot test: no default AI model selected in System Intelligence Config.")
            return HttpResponseRedirect(change_url)

        try:
            client = boto3.client(
                "bedrock-runtime",
                region_name=obj.default_region or "us-west-2",
                aws_access_key_id=obj.access_key_id,
                aws_secret_access_key=obj.get_secret_access_key(),
            )
            resp = client.converse(
                modelId=model_id,
                messages=[{"role": "user", "content": [{"text": "Reply with exactly: OK"}]}],
                inferenceConfig={"maxTokens": 16, "temperature": 0},
            )
            output_text = resp["output"]["message"]["content"][0]["text"]
            messages.success(request, 'Bedrock API test passed. Model responded: "' + output_text.strip() + '"')
        except ClientError as exc:
            messages.error(request, f"Bedrock API test failed: {exc.response['Error']['Message']}")
        except Exception as exc:
            messages.error(request, f"Bedrock API test failed: {exc}")

        return HttpResponseRedirect(change_url)

    def has_delete_permission(self, request, obj=None):
        if obj is not None and obj.is_active:
            return False
        return super().has_delete_permission(request, obj)

    def get_actions(self, request):
        actions = super().get_actions(request)
        actions.pop("delete_selected", None)
        return actions

    def get_urls(self):
        custom_urls = self._get_test_send_urls("core_awscredentialconfig")
        return custom_urls + super().get_urls()
