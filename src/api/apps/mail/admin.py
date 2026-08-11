from django import forms
from django.contrib import admin, messages
from django.utils import timezone
from unfold.admin import ModelAdmin

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


@admin.register(EmailProviderConfig)
class EmailProviderConfigAdmin(ModelAdmin):
    form = EmailProviderConfigForm
    actions = ["send_test_email"]
    list_display = ("name", "is_active", "from_email", "last_tested_at", "last_error")
    list_filter = ("is_active",)
    readonly_fields = ("last_tested_at", "last_error")
    search_fields = ("name", "from_email")

    @admin.action(description="Send test email to configured sender")
    def send_test_email(self, request, queryset):
        sent = 0
        for config in queryset:
            try:
                send_email_message(
                    subject="Releviz email delivery test",
                    body="This is a Releviz AWS SES delivery test.",
                    recipients=[config.from_email],
                    message_type=EmailMessageLog.MessageType.TEST,
                    provider_config=config,
                )
                config.last_tested_at = timezone.now()
                config.last_error = ""
                config.save(update_fields=["last_tested_at", "last_error", "updated_at"])
                sent += 1
            except EmailDeliveryError as exc:
                config.last_error = str(exc)
                config.save(update_fields=["last_error", "updated_at"])
        if sent:
            self.message_user(request, f"Sent {sent} test email(s).", messages.SUCCESS)


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
        "auth_session",
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
