"""Auto-resolve the SMS origination identity for the active AWS account.

The outbound-SMS origination number is discovered from AWS End User Messaging
(``pinpoint-sms-voice-v2:DescribePhoneNumbers``) instead of being typed into the
admin by hand — the same stack that actually sends the messages.
An optional ``AWSCredentialConfig.sms_from_number`` still acts as a manual
override; when it is blank the number is auto-detected and cached so repeated
readiness checks and sends don't re-hit AWS on every call.
"""

from __future__ import annotations

import logging

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from django.core.cache import cache

from .credentials import AwsCredentials, AwsCredentialsError, resolve_aws_credentials

logger = logging.getLogger(__name__)

_CACHE_PREFIX = "aws:sns:origination_number"
_CACHE_TTL = 6 * 60 * 60  # 6 hours
_NONE_SENTINEL = ""  # cache an empty string to remember "checked, found nothing"


def _cache_key(region: str) -> str:
    return f"{_CACHE_PREFIX}:{region}"


def _list_active_origination_number(creds: AwsCredentials) -> str | None:
    """Return the first ACTIVE, SMS-capable origination number on the account."""
    client = boto3.client(
        "pinpoint-sms-voice-v2",
        region_name=creds.region,
        aws_access_key_id=creds.access_key_id,
        aws_secret_access_key=creds.secret_access_key,
    )
    next_token = None
    while True:
        kwargs = {"NextToken": next_token} if next_token else {}
        response = client.describe_phone_numbers(**kwargs)
        for number in response.get("PhoneNumbers", []):
            if number.get("Status") != "ACTIVE":
                continue
            if "SMS" not in (number.get("NumberCapabilities") or []):
                continue
            phone_number = number.get("PhoneNumber")
            if phone_number:
                return phone_number
        next_token = response.get("NextToken")
        if not next_token:
            return None


def resolve_origination_number(*, refresh: bool = False) -> str | None:
    """Return an Active, SMS-capable origination number for the active account.

    Cached for ``_CACHE_TTL``. Returns ``None`` when no AWS credentials are
    configured or no usable number exists. On a transient AWS error the last
    cached value (if any) is returned rather than failing the caller.
    """
    try:
        creds = resolve_aws_credentials("sns")
    except AwsCredentialsError:
        return None

    key = _cache_key(creds.region)
    if not refresh:
        cached = cache.get(key)
        if cached is not None:
            return cached or None

    try:
        number = _list_active_origination_number(creds)
    except (ClientError, BotoCoreError):
        logger.warning("Failed to list SMS origination numbers", exc_info=True)
        stale = cache.get(key)
        return stale or None

    cache.set(key, number or _NONE_SENTINEL, _CACHE_TTL)
    return number


def origination_number_available() -> bool:
    """True when an SMS origination number can be resolved for the account."""
    return bool(resolve_origination_number())


def clear_origination_number_cache(region: str | None = None) -> None:
    """Drop the cached origination number so the next resolve re-hits AWS."""
    if region:
        cache.delete(_cache_key(region))
        return
    try:
        creds = resolve_aws_credentials("sns")
    except AwsCredentialsError:
        return
    cache.delete(_cache_key(creds.region))
