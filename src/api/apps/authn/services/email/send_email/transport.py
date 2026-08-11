import logging

from botocore.exceptions import BotoCoreError, ClientError

from apps.core.services.aws.credentials import AwsCredentialsError, resolve_aws_credentials
from apps.core.services.aws.provider_outcomes import (
    NO_PROVIDER_RETRIES,
    ProviderDeliveryError,
    classify_aws_send_failure,
)

logger = logging.getLogger(__name__)


def _load_config():
    from apps.core.models import EmailServiceConfig

    return EmailServiceConfig.load()


def _send_via_ses(
    *,
    config,
    recipient: str,
    subject: str,
    html_body: str,
    before_provider_call=None,
    raise_provider_errors: bool = False,
) -> bool:
    if not config.ses_configured:
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
            Source=config.source_address,
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
