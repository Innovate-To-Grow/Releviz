from django import forms
from django.contrib import admin, messages
from django.utils import timezone
from unfold.admin import ModelAdmin

from apps.messaging.models import EmailMessageLog, EmailProviderConfig
from apps.messaging.services import EmailDeliveryError, send_email_message


class EmailProviderConfigForm(forms.ModelForm):
    secret_access_key = forms.CharField(
        required=False,
        widget=forms.PasswordInput(render_value=False),
        help_text="Leave blank to keep the existing AWS secret access key.",
    )

    class Meta:
        model = EmailProviderConfig
        fields = (
            "name",
            "is_active",
            "aws_region",
            "from_email",
            "reply_to_email",
            "aws_access_key_id",
            "secret_access_key",
        )

    def save(self, commit=True):
        instance = super().save(commit=False)
        instance.set_secret_access_key(self.cleaned_data.get("secret_access_key", ""))
        if commit:
            instance.save()
            self.save_m2m()
        return instance


@admin.register(EmailProviderConfig)
class EmailProviderConfigAdmin(ModelAdmin):
    form = EmailProviderConfigForm
    actions = ["send_test_email"]
    list_display = ("name", "is_active", "aws_region", "from_email", "last_tested_at", "last_error")
    list_filter = ("is_active", "aws_region")
    readonly_fields = ("encrypted_secret_access_key", "last_tested_at", "last_error")
    search_fields = ("name", "from_email", "aws_access_key_id")

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
        "created_at",
        "updated_at",
    )
