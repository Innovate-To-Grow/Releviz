import boto3

from apps.core.models import AWSCredentialConfig

from ..exceptions import BedrockError


def get_aws_config(aws_config=None):
    if aws_config is None:
        aws_config = AWSCredentialConfig.load()
    if not aws_config.is_configured:
        raise BedrockError("AWS credentials are not configured. Add an active AWS Credential Config first.")
    return aws_config


def get_client(aws_config=None):
    """Build a bedrock-runtime boto3 client from active AWS credentials."""
    aws_config = get_aws_config(aws_config)
    return boto3.client(
        "bedrock-runtime",
        region_name=aws_config.region,
        aws_access_key_id=aws_config.access_key_id,
        aws_secret_access_key=aws_config.secret_access_key,
    )


def get_management_client(aws_config=None):
    """Build a bedrock management client for model discovery."""
    aws_config = get_aws_config(aws_config)
    return boto3.client(
        "bedrock",
        region_name=aws_config.region,
        aws_access_key_id=aws_config.access_key_id,
        aws_secret_access_key=aws_config.secret_access_key,
    )


def get_cloudwatch_client(aws_config=None):
    """Build a CloudWatch client for reading free Bedrock usage metrics.

    Used solely for ``ListMetrics`` and ``GetMetricData`` (both free reads).
    Cost Explorer (``ce``) is intentionally never used -- those calls are
    billed per request.
    """
    aws_config = get_aws_config(aws_config)
    return boto3.client(
        "cloudwatch",
        region_name=aws_config.region,
        aws_access_key_id=aws_config.access_key_id,
        aws_secret_access_key=aws_config.secret_access_key,
    )
