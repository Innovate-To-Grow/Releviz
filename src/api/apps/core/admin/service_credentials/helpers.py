import logging

from apps.core.services.aws.credentials import AwsCredentialsError, resolve_aws_credentials

logger = logging.getLogger(__name__)


def _normalize_phone_number(country_code, recipient):
    """Build an E.164 number, stripping a leading '+' the admin may have pasted."""
    recipient = recipient.lstrip("+").strip()
    if not recipient:
        return ""
    return country_code + recipient


def _send_test_email(*, config, recipient):
    """Send a test email using the given EmailServiceConfig. Returns provider name."""
    subject = "Test Email — Innovate to Grow Admin"
    html_body = (
        "<h2>Test Email</h2>"
        "<p>This is a test email sent from the I2G admin panel.</p>"
        "<p>Your email service configuration is working correctly.</p>"
    )

    if not config.ses_configured:
        raise RuntimeError("Email delivery is not configured. Configure AWS SES in Notification Delivery.")

    try:
        import boto3

        creds = resolve_aws_credentials("ses")
        client = boto3.client(
            "ses",
            region_name=creds.region,
            aws_access_key_id=creds.access_key_id,
            aws_secret_access_key=creds.secret_access_key,
        )
        client.send_email(
            Destination={"ToAddresses": [recipient]},
            Message={
                "Body": {"Html": {"Charset": "UTF-8", "Data": html_body}},
                "Subject": {"Charset": "UTF-8", "Data": subject},
            },
            Source=config.source_address,
        )
        return "AWS SES"
    except AwsCredentialsError as exc:
        logger.warning("SES test send skipped: AWS credentials are not configured")
        raise RuntimeError("AWS credentials are not configured.") from exc
    except Exception as exc:
        logger.exception("SES test send failed for %s", recipient)
        raise RuntimeError("AWS SES test send failed. Check server logs for details.") from exc


def _send_test_sms(*, phone_number):
    """Send a test SMS via AWS End User Messaging (origination number from active AWSCredentialConfig)."""
    from apps.authn.services.sms import publish_plain_sms

    message_id = publish_plain_sms(
        phone_number=phone_number,
        message="This is a test message from the Innovate to Grow admin panel. Your SMS configuration is working correctly.",
    )
    return f"message (ID: {message_id})"
