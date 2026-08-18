import logging

from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.utils.html import strip_tags

from apps.core.services.aws.credentials import AwsCredentialsError, resolve_aws_credentials
from apps.core.services.aws.provider_outcomes import (
    NO_PROVIDER_RETRIES,
    ProviderDeliveryError,
    classify_aws_send_failure,
)
from apps.mail.terminal_output import print_email_to_terminal

logger = logging.getLogger(__name__)


def _active_source_address() -> str:
    """Return the sender address configured for the active email provider."""
    from apps.mail.models import EmailProviderConfig

    provider = EmailProviderConfig.objects.filter(is_active=True).first()
    return provider.from_email if provider is not None else ""


def _send_via_django_backend(*, recipient: str, subject: str, html_body: str) -> bool:
    """Deliver through ``EMAIL_BACKEND`` when SES is deliberately unavailable.

    Production always sends via SES. Environments without SES credentials --
    E2E, which writes to a file sink, and local development -- opt in with
    ``AUTH_EMAIL_DJANGO_BACKEND_FALLBACK`` so verification codes are still
    delivered somewhere observable instead of failing the request.
    """
    if getattr(settings, "PRINT_EMAILS_TO_TERMINAL", False):
        print_email_to_terminal(
            subject=subject,
            from_email=getattr(settings, "DEFAULT_FROM_EMAIL", "") or "",
            recipients=[recipient],
            body=strip_tags(html_body),
            html_body=html_body,
        )
        return True
    if not getattr(settings, "AUTH_EMAIL_DJANGO_BACKEND_FALLBACK", False):
        return False

    message = EmailMultiAlternatives(
        subject=subject,
        body=strip_tags(html_body),
        from_email=getattr(settings, "DEFAULT_FROM_EMAIL", None),
        to=[recipient],
    )
    message.attach_alternative(html_body, "text/html")
    if message.send(fail_silently=False) == 0:
        logger.error("Django email backend did not send the message")
        return False
    logger.info("Email sent via the Django email backend")
    return True


def _send_via_ses(
    *,
    recipient: str,
    subject: str,
    html_body: str,
    source_address: str | None = None,
    before_provider_call=None,
    raise_provider_errors: bool = False,
) -> bool:
    if getattr(settings, "PRINT_EMAILS_TO_TERMINAL", False):
        print_email_to_terminal(
            subject=subject,
            from_email=source_address or getattr(settings, "DEFAULT_FROM_EMAIL", ""),
            recipients=[recipient],
            body=strip_tags(html_body),
            html_body=html_body,
        )
        return True
    if source_address is None:
        source_address = _active_source_address()
    if not source_address:
        logger.warning("SES send skipped: no active email provider is configured")
        return False
    try:
        import apps.authn.services.email.send_email as email_api

        creds = resolve_aws_credentials("ses")
        client = email_api.boto3.client(
            "ses",
            region_name=creds.region,
            aws_access_key_id=creds.access_key_id,
            aws_secret_access_key=creds.secret_access_key,
            config=NO_PROVIDER_RETRIES,
        )
        if before_provider_call is not None:
            before_provider_call()
        client.send_email(
            Destination={"ToAddresses": [recipient]},
            Message={
                "Body": {"Html": {"Charset": "UTF-8", "Data": html_body}},
                "Subject": {"Charset": "UTF-8", "Data": subject},
            },
            Source=source_address,
        )
        return True
    except AwsCredentialsError:
        logger.warning("SES send skipped: AWS credentials are not configured")
        return False
    except (BotoCoreError, ClientError) as exc:
        logger.exception("SES send failed while sending email")
        if raise_provider_errors:
            outcome, message = classify_aws_send_failure(exc, provider="SES")
            raise ProviderDeliveryError(message, outcome=outcome) from exc
        return False
