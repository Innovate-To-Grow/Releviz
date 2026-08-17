"""Shared AWS credential resolution for services that reuse the same IAM user."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AwsCredentials:
    access_key_id: str
    secret_access_key: str
    region: str


class AwsCredentialsError(RuntimeError):
    """Raised when no AWS credentials are configured."""


def aws_credentials_available() -> bool:
    """Return True when shared AWS credentials can be resolved."""
    try:
        resolve_aws_credentials()
    except AwsCredentialsError:
        return False
    return True


def resolve_aws_credentials(service: str = "default") -> AwsCredentials:
    """Resolve AWS credentials from the active AWSCredentialConfig.

    The ``service`` argument is kept for call-site readability and future AWS
    integrations; current callers use the shared configuration for SES.
    """
    from apps.core.models import AWSCredentialConfig

    aws = AWSCredentialConfig.load()
    if not aws.is_configured:
        raise AwsCredentialsError("AWS credentials are not configured.")

    return AwsCredentials(
        access_key_id=aws.access_key_id,
        secret_access_key=aws.get_secret_access_key(),
        region=aws.region,
    )
