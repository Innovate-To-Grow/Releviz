from django import forms
from django.contrib import admin, messages
from django.http import HttpResponseRedirect
from django.template.response import TemplateResponse
from django.urls import reverse
from django.utils import timezone
from django.utils.html import format_html
from unfold.admin import ModelAdmin
from unfold.decorators import action, display
from unfold.enums import ActionVariant
from unfold.widgets import UnfoldAdminEmailInputWidget

from apps.core.models import AWSCredentialConfig
from apps.mail.models import (
    EmailDeliveryJob,
    EmailDeliveryRequest,
    EmailMessageLog,
    EmailProviderConfig,
)
from apps.mail.services import EmailDeliveryError, send_email_message


class EmailProviderConfigForm(forms.ModelForm):
    class Meta:
        model = EmailProviderConfig
        fields = (
            "name",
            "is_active",
            "from_email",
            "reply_to_email",
        )


class TestEmailForm(forms.Form):
    recipient = forms.EmailField(
        label="Recipient email",
        widget=UnfoldAdminEmailInputWidget(
            attrs={
                "autocomplete": "email",
                "placeholder": "recipient@example.com",
            }
        ),
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        active_provider = EmailProviderConfig.objects.filter(is_active=True).first()
        if active_provider is not None:
            self.fields["recipient"].initial = active_provider.from_email


@admin.register(EmailProviderConfig)
class EmailProviderConfigAdmin(ModelAdmin):
    form = EmailProviderConfigForm
    actions_list = ["send_test_email"]
    list_display = (
        "name",
        "is_active",
        "from_email",
        "aws_credentials_status",
        "last_tested_at",
        "last_error",
    )
    list_filter = ("is_active",)
    readonly_fields = ("active_aws_credentials", "last_tested_at", "last_error")
    search_fields = ("name", "from_email")
    fieldsets = (
        (
            None,
            {"fields": ("name", "is_active", "from_email", "reply_to_email")},
        ),
        (
            "AWS Credentials",
            {
                "fields": ("active_aws_credentials",),
                "description": (
                    "SES uses the active AWS Credentials from Site Settings. "
                    "AWS keys are not stored on this email sender configuration."
                ),
            },
        ),
        ("Test Status", {"fields": ("last_tested_at", "last_error")}),
    )

    @staticmethod
    def _active_aws_credentials():
        return AWSCredentialConfig.objects.filter(is_active=True).first()

    @display(description="AWS Credentials", label=True)
    def aws_credentials_status(self, obj):
        credentials = self._active_aws_credentials()
        if credentials is not None and credentials.is_configured:
            return "Configured", "success"
        return "Not configured", "warning"

    @admin.display(description="Active AWS Credentials")
    def active_aws_credentials(self, obj):
        credentials = self._active_aws_credentials()
        if credentials is None:
            url = reverse("admin:core_awscredentialconfig_changelist")
            return format_html(
                '<span class="text-base-500 dark:text-base-400">'
                "No active AWS Credentials.</span> "
                '<a class="text-primary-600 dark:text-primary-500" href="{}">'
                "Open AWS Credentials</a>",
                url,
            )

        url = reverse("admin:core_awscredentialconfig_change", args=(credentials.pk,))
        key_hint = (
            f"•••• {credentials.access_key_id[-4:]}" if credentials.access_key_id else "Not set"
        )
        state = "Configured" if credentials.is_configured else "Incomplete"
        return format_html(
            '<div class="flex flex-wrap gap-x-6 gap-y-2 items-center">'
            '<a class="font-medium text-primary-600 dark:text-primary-500" href="{}">{}</a>'
            '<span><span class="text-base-500 dark:text-base-400">Access Key:</span> {}</span>'
            '<span><span class="text-base-500 dark:text-base-400">Region:</span> {}</span>'
            '<span><span class="text-base-500 dark:text-base-400">Status:</span> {}</span>'
            "</div>",
            url,
            credentials.name,
            key_hint,
            credentials.region,
            state,
        )

    @action(
        description="Send test email",
        url_path="send-test-email",
        icon="send",
        permissions=["change"],
        variant=ActionVariant.DEFAULT,
    )
    def send_test_email(self, request):
        changelist_url = reverse("admin:mail_emailproviderconfig_changelist")
        config = EmailProviderConfig.objects.filter(is_active=True).first()
        credentials = self._active_aws_credentials()
        form = TestEmailForm(request.POST or None)

        if request.method == "POST" and form.is_valid():
            if config is None:
                self.message_user(
                    request,
                    "No active Email Provider is configured.",
                    messages.ERROR,
                )
                return HttpResponseRedirect(changelist_url)

            recipient = form.cleaned_data["recipient"]
            try:
                send_email_message(
                    subject="Releviz email delivery test",
                    body="This is a Releviz AWS SES delivery test.",
                    recipients=[recipient],
                    message_type=EmailMessageLog.MessageType.TEST,
                    provider_config=config,
                )
            except EmailDeliveryError as exc:
                config.last_error = str(exc)
                config.save(update_fields=["last_error", "updated_at"])
                self.message_user(
                    request,
                    f"Test email failed: {exc}",
                    messages.ERROR,
                )
            else:
                config.last_tested_at = timezone.now()
                config.last_error = ""
                config.save(update_fields=["last_tested_at", "last_error", "updated_at"])
                self.message_user(
                    request,
                    f"Test email sent to {recipient}.",
                    messages.SUCCESS,
                )

            return HttpResponseRedirect(changelist_url)

        context = {
            **self.admin_site.each_context(request),
            "title": "Send test email",
            "opts": self.model._meta,
            "form": form,
            "active_provider": config,
            "active_credentials": credentials,
            "changelist_url": changelist_url,
        }
        return TemplateResponse(
            request,
            "admin/mail/emailproviderconfig/send_test_email.html",
            context,
        )


@admin.register(EmailMessageLog)
class EmailMessageLogAdmin(ModelAdmin):
    list_display = ("message_type", "recipient", "status", "subject", "created_at")
    list_filter = ("message_type", "status")
    search_fields = ("recipient", "subject", "provider_message_id", "error")
    readonly_fields = (
        "message_type",
        "recipient",
        "subject",
        "status",
        "provider_message_id",
        "error",
        "event",
        "invitation",
        "delivery_job",
        "created_at",
        "updated_at",
    )


@admin.register(EmailDeliveryJob)
class EmailDeliveryJobAdmin(ModelAdmin):
    list_display = (
        "message_type",
        "recipient",
        "status",
        "attempt_count",
        "max_attempts",
        "next_attempt_at",
        "event",
        "member",
    )
    list_filter = ("message_type", "status")
    search_fields = (
        "recipient",
        "subject",
        "idempotency_key",
        "message_id",
        "provider_message_id",
        "event__code",
        "member__email",
        "member__contact_emails__email_address",
        "invitation__email",
    )
    readonly_fields = (
        "idempotency_key",
        "message_type",
        "recipient",
        "subject",
        "body",
        "html_body",
        "content_encrypted",
        "attachments",
        "message_id",
        "event",
        "invitation",
        "member",
        "auth_challenge",
        "status",
        "attempt_count",
        "max_attempts",
        "next_attempt_at",
        "locked_at",
        "lock_token",
        "sent_at",
        "provider_message_id",
        "last_error",
        "created_at",
        "updated_at",
    )


@admin.register(EmailDeliveryRequest)
class EmailDeliveryRequestAdmin(ModelAdmin):
    list_display = (
        "operation",
        "event",
        "requested_by",
        "recipient_count",
        "created_job_count",
        "idempotency_key",
        "created_at",
    )
    list_filter = ("operation",)
    search_fields = (
        "event__code",
        "event__name",
        "requested_by__email",
        "idempotency_key",
        "request_fingerprint",
    )
    readonly_fields = (
        "event",
        "requested_by",
        "operation",
        "idempotency_key",
        "request_fingerprint",
        "recipient_count",
        "created_job_count",
        "jobs",
        "created_at",
        "updated_at",
    )
