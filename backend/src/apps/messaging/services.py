from __future__ import annotations

import re
from dataclasses import dataclass
from email.utils import make_msgid
from urllib.parse import urlencode

from django.conf import settings
from django.core.mail import EmailMultiAlternatives

from apps.messaging.models import EmailMessageLog, EmailProviderConfig


class EmailDeliveryError(RuntimeError):
    pass


@dataclass(frozen=True)
class EmailAttachment:
    filename: str
    content: str
    mimetype: str


def _clean_header(value: str) -> str:
    return re.sub(r"[\r\n]+", " ", str(value or "")).strip()


def active_provider_config() -> EmailProviderConfig | None:
    return EmailProviderConfig.objects.filter(is_active=True).first()


def frontend_url(path: str, **params) -> str:
    base = (getattr(settings, "FRONTEND_URL", "") or getattr(settings, "BACKEND_URL", "")).rstrip(
        "/"
    )
    query = f"?{urlencode(params)}" if params else ""
    return f"{base}{path}{query}" if base else f"{path}{query}"


def _message(
    *,
    subject: str,
    body: str,
    recipients: list[str],
    from_email: str,
    reply_to: str = "",
    html_body: str = "",
    attachments: list[EmailAttachment] | None = None,
) -> EmailMultiAlternatives:
    message = EmailMultiAlternatives(
        subject=_clean_header(subject),
        body=body,
        from_email=from_email,
        to=recipients,
        reply_to=[reply_to] if reply_to else None,
        headers={"Message-ID": make_msgid(domain="releviz.local")},
    )
    if html_body:
        message.attach_alternative(html_body, "text/html")
    for attachment in attachments or []:
        message.attach(attachment.filename, attachment.content, attachment.mimetype)
    return message


def _send_with_ses(message: EmailMultiAlternatives, config: EmailProviderConfig) -> str:
    secret = config.get_secret_access_key()
    if not config.aws_access_key_id or not secret:
        raise EmailDeliveryError("AWS SES access key and secret access key are required.")
    try:
        import boto3
    except ImportError as exc:  # pragma: no cover - dependency is installed in supported envs
        raise EmailDeliveryError("boto3 is required for AWS SES email delivery.") from exc

    client = boto3.client(
        "ses",
        region_name=config.aws_region,
        aws_access_key_id=config.aws_access_key_id,
        aws_secret_access_key=secret,
    )
    response = client.send_raw_email(
        Source=message.from_email,
        Destinations=list(message.to),
        RawMessage={"Data": message.message().as_bytes()},
    )
    return response.get("MessageId", "")


def _log_each(
    *,
    recipients: list[str],
    subject: str,
    message_type: str,
    status: str,
    provider_message_id: str = "",
    error: str = "",
    event=None,
    invitation=None,
) -> None:
    EmailMessageLog.objects.bulk_create(
        [
            EmailMessageLog(
                message_type=message_type,
                recipient=recipient,
                subject=subject,
                status=status,
                provider_message_id=provider_message_id,
                error=error,
                event=event,
                invitation=invitation,
            )
            for recipient in recipients
        ]
    )


def send_email_message(
    *,
    subject: str,
    body: str,
    recipients: list[str],
    message_type: str,
    html_body: str = "",
    attachments: list[EmailAttachment] | None = None,
    event=None,
    invitation=None,
    provider_config: EmailProviderConfig | None = None,
) -> str:
    clean_recipients = [recipient.strip().lower() for recipient in recipients if recipient.strip()]
    if not clean_recipients:
        raise EmailDeliveryError("At least one recipient is required.")

    config = provider_config or active_provider_config()
    from_email = (
        config.from_email
        if config
        else getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@releviz.local")
    )
    reply_to = config.reply_to_email if config else ""
    message = _message(
        subject=subject,
        body=body,
        html_body=html_body,
        recipients=clean_recipients,
        from_email=from_email,
        reply_to=reply_to,
        attachments=attachments,
    )

    try:
        if getattr(settings, "USE_SES_EMAIL_PROVIDER", False):
            if config is None:
                raise EmailDeliveryError("No active AWS SES email provider is configured.")
            provider_message_id = _send_with_ses(message, config)
        else:
            sent_count = message.send(fail_silently=False)
            if sent_count == 0:
                raise EmailDeliveryError("Django email backend did not send the message.")
            provider_message_id = ""
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
        _log_each(
            recipients=clean_recipients,
            subject=subject,
            message_type=message_type,
            status=EmailMessageLog.Status.FAILED,
            error=error,
            event=event,
            invitation=invitation,
        )
        if isinstance(exc, EmailDeliveryError):
            raise
        raise EmailDeliveryError(error) from exc

    _log_each(
        recipients=clean_recipients,
        subject=subject,
        message_type=message_type,
        status=EmailMessageLog.Status.SENT,
        provider_message_id=provider_message_id,
        event=event,
        invitation=invitation,
    )
    return provider_message_id
