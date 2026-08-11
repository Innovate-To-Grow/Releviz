"""Mixin providing shared 'Test Email' and 'Test SMS' changelist actions."""

from django.contrib import messages
from django.http import HttpResponseRedirect
from django.template.response import TemplateResponse
from django.urls import path, reverse
from unfold.decorators import action

from apps.core.models import AWSCredentialConfig, EmailServiceConfig

from .helpers import _normalize_phone_number, _send_test_email, _send_test_sms


class TestSendViewsMixin:
    """Adds test-email and test-sms changelist actions + URL views to a credential admin."""

    def _get_test_send_urls(self, url_prefix):
        """Return URL patterns for test-email and test-sms views.

        Args:
            url_prefix: model name prefix for the URL name, e.g. 'core_awscredentialconfig'.
        """
        return [
            path(
                "test-email/",
                self.admin_site.admin_view(self.test_email_list_view),
                name=f"{url_prefix}_test_email",
            ),
            path(
                "test-sms/",
                self.admin_site.admin_view(self.test_sms_list_view),
                name=f"{url_prefix}_test_sms",
            ),
        ]

    @action(description="Test Email", url_path="test-email-action", icon="mail")
    def test_email_list(self, request):
        opts = self.model._meta
        return HttpResponseRedirect(reverse(f"admin:{opts.app_label}_{opts.model_name}_test_email"))

    @action(description="Test SMS", url_path="test-sms-action", icon="sms")
    def test_sms_list(self, request):
        opts = self.model._meta
        return HttpResponseRedirect(reverse(f"admin:{opts.app_label}_{opts.model_name}_test_sms"))

    def test_email_list_view(self, request):
        config = EmailServiceConfig.load()
        opts = self.model._meta
        form_url = reverse(f"admin:{opts.app_label}_{opts.model_name}_test_email")
        changelist_url = reverse(f"admin:{opts.app_label}_{opts.model_name}_changelist")

        if request.method == "POST":
            recipient = request.POST.get("recipient", "").strip()
            if not recipient:
                messages.error(request, "Please provide a recipient email address.")
                return HttpResponseRedirect(form_url)
            try:
                provider = _send_test_email(config=config, recipient=recipient)
                messages.success(request, f"Test email sent to {recipient} via {provider} (config: {config.name}).")
            except Exception as exc:
                messages.error(request, f"Failed to send test email: {exc}")
            return HttpResponseRedirect(changelist_url)

        context = {
            **self.admin_site.each_context(request),
            "title": f"Send Test Email — {config.name}",
            "input_label": "Recipient email address",
            "input_type": "email",
            "input_placeholder": "admin@example.com",
            "input_help": f"A test email will be sent from {config.source_address} through AWS SES.",
            "submit_label": "Send Test Email",
            "cancel_url": changelist_url,
        }
        return TemplateResponse(request, "admin/core/test_send_form.html", context)

    def test_sms_list_view(self, request):
        config = AWSCredentialConfig.load()
        opts = self.model._meta
        form_url = reverse(f"admin:{opts.app_label}_{opts.model_name}_test_sms")
        changelist_url = reverse(f"admin:{opts.app_label}_{opts.model_name}_changelist")

        if request.method == "POST":
            country_code = request.POST.get("country_code", "+1")
            recipient = request.POST.get("recipient", "").strip()
            if not recipient:
                messages.error(request, "Please provide a phone number.")
                return HttpResponseRedirect(form_url)
            full_number = _normalize_phone_number(country_code, recipient)
            try:
                result = _send_test_sms(phone_number=full_number)
                messages.success(request, f"Test SMS sent to {full_number}: {result} (AWS config: {config.name}).")
            except Exception as exc:
                messages.error(request, f"Failed to send test SMS: {exc}")
            return HttpResponseRedirect(changelist_url)

        context = {
            **self.admin_site.each_context(request),
            "title": f"Send Test SMS — {config.name}",
            "input_label": "Recipient phone number",
            "input_type": "tel",
            "input_placeholder": "2345678901",
            "input_help": "Select country code and enter the phone number.",
            "submit_label": "Send Test SMS",
            "cancel_url": changelist_url,
        }
        return TemplateResponse(request, "admin/core/test_send_form.html", context)
