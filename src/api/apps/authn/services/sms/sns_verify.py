"""
AWS SMS service for phone number verification.

OTP codes are generated locally, stored in PostgreSQL, and delivered through AWS
End User Messaging (``pinpoint-sms-voice-v2`` SendTextMessage). Dedicated
origination numbers (toll-free/10DLC) are managed by End User Messaging, so the
legacy ``sns:Publish`` path cannot use them — it rejects the number with
"does not belong to the account". AWS credentials, region, and the origination
identity all live on AWSCredentialConfig.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import threading
from contextlib import contextmanager
from datetime import timedelta
from uuid import UUID

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from django.contrib.auth.hashers import check_password, make_password
from django.core.exceptions import ValidationError
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.authn.models import PhoneVerificationChallenge
from apps.core.services.aws.credentials import AwsCredentialsError, resolve_aws_credentials

logger = logging.getLogger(__name__)

OTP_TTL_SECONDS = 600
VERIFIED_GRANT_TTL_SECONDS = 900
MAX_VERIFY_ATTEMPTS = 5
MAX_SENDS_PER_HOUR = 10
DEFAULT_STATUS = "pending"
DEFAULT_PURPOSE = PhoneVerificationChallenge.Purpose.PHONE_AUTH
ACTIVE_STATUSES = (
    PhoneVerificationChallenge.Status.SENDING,
    PhoneVerificationChallenge.Status.PENDING,
    PhoneVerificationChallenge.Status.VERIFIED,
)
VERIFIABLE_STATUSES = (
    PhoneVerificationChallenge.Status.SENDING,
    PhoneVerificationChallenge.Status.PENDING,
)
_LOCAL_PHONE_LOCKS = tuple(threading.Lock() for _ in range(64))


class PhoneVerificationError(RuntimeError):
    """Base exception for phone verification failures."""


class PhoneVerificationThrottled(PhoneVerificationError):
    """Too many verification attempts."""


class PhoneVerificationInvalid(PhoneVerificationError):
    """Invalid or expired verification code."""


class PhoneVerificationDeliveryError(PhoneVerificationError):
    """Failed to send SMS."""


def _load_aws_config():
    from apps.core.models import AWSCredentialConfig

    return AWSCredentialConfig.load()


def _random_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _assert_configured():
    """Ensure AWS SMS settings are ready."""
    aws = _load_aws_config()
    if not aws.sns_configured:
        raise PhoneVerificationDeliveryError("SMS is not configured.")
    return aws


def _get_smsvoice_client():
    try:
        creds = resolve_aws_credentials("sns")
    except AwsCredentialsError as exc:
        raise PhoneVerificationDeliveryError("AWS credentials are not configured.") from exc

    return boto3.client(
        "pinpoint-sms-voice-v2",
        region_name=creds.region,
        aws_access_key_id=creds.access_key_id,
        aws_secret_access_key=creds.secret_access_key,
    )


def _publish_sms(*, phone_number: str, message: str, aws_config) -> str:
    origination_identity = aws_config.resolved_sms_from_number()
    if not origination_identity:
        raise PhoneVerificationDeliveryError("SMS is not configured.")

    client = _get_smsvoice_client()
    try:
        response = client.send_text_message(
            DestinationPhoneNumber=phone_number,
            OriginationIdentity=origination_identity,
            MessageBody=message,
            MessageType="TRANSACTIONAL",
        )
    except ClientError as exc:
        error_code = exc.response.get("Error", {}).get("Code", "")
        logger.warning("send_text_message failed: code=%s", error_code)
        if error_code in {"ThrottlingException", "TooManyRequestsException", "ServiceQuotaExceededException"}:
            raise PhoneVerificationThrottled("Too many verification attempts. Please try again later.") from exc
        if error_code == "ValidationException":
            raise PhoneVerificationInvalid("Invalid phone number.") from exc
        # ConflictException / ResourceNotFoundException / AccessDeniedException point at the
        # origination identity or account state, not a bad recipient — surface as delivery errors.
        raise PhoneVerificationDeliveryError("Failed to send verification SMS.") from exc
    except BotoCoreError as exc:
        logger.warning("send_text_message failed", exc_info=True)
        raise PhoneVerificationDeliveryError("Failed to send verification SMS.") from exc

    return response.get("MessageId", "")


def _phone_lock_id(phone_number: str) -> int:
    digest = hashlib.sha256(phone_number.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=True)


@contextmanager
def _lock_phone(phone_number: str):
    """Serialize one phone across reservation, provider call, and finalization."""
    lock_id = _phone_lock_id(phone_number)
    local_lock = _LOCAL_PHONE_LOCKS[abs(lock_id) % len(_LOCAL_PHONE_LOCKS)]
    with local_lock:
        if connection.vendor != "postgresql":
            yield
            return
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_lock(%s)", [lock_id])
        try:
            yield
        finally:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_unlock(%s)", [lock_id])


def _mark_challenge_sent(challenge_id) -> bool:
    now = timezone.now()
    return bool(
        PhoneVerificationChallenge.objects.filter(
            pk=challenge_id,
            status=PhoneVerificationChallenge.Status.SENDING,
        ).update(
            status=PhoneVerificationChallenge.Status.PENDING,
            sent_at=now,
            updated_at=now,
        )
    )


def _mark_challenge_delivery_failed(challenge_id) -> None:
    try:
        PhoneVerificationChallenge.objects.filter(
            pk=challenge_id,
            status=PhoneVerificationChallenge.Status.SENDING,
        ).update(
            status=PhoneVerificationChallenge.Status.EXPIRED,
            updated_at=timezone.now(),
        )
    except Exception:  # noqa: BLE001 - the durable reservation must remain visible.
        logger.exception("Unable to record SMS delivery failure for challenge %s", challenge_id)


def start_phone_verification(
    phone_number: str,
    *,
    purpose: str = DEFAULT_PURPOSE,
    member=None,
    context_identifier: str = "",
) -> dict[str, str]:
    """
    Generate and durably store an OTP, then send it via AWS End User Messaging.

    Returns ``{"status": "pending", "challenge_id": "..."}``.
    """
    aws_config = _assert_configured()
    code = _random_code()
    now = timezone.now()
    with _lock_phone(phone_number):
        # Commit the reservation before the external provider call. A crash or
        # database failure after delivery can no longer erase the hourly cap.
        try:
            with transaction.atomic():
                recent_sends = PhoneVerificationChallenge.objects.filter(
                    phone_number=phone_number,
                    send_reserved_at__gte=now - timedelta(hours=1),
                ).count()
                if recent_sends >= MAX_SENDS_PER_HOUR:
                    raise PhoneVerificationThrottled("Too many verification attempts. Please try again later.")
                PhoneVerificationChallenge.objects.select_for_update().filter(
                    phone_number=phone_number,
                    purpose=purpose,
                    status__in=ACTIVE_STATUSES,
                ).update(
                    status=PhoneVerificationChallenge.Status.EXPIRED,
                    updated_at=now,
                )
                challenge = PhoneVerificationChallenge.objects.create(
                    phone_number=phone_number,
                    purpose=purpose,
                    member=member,
                    context_identifier=str(context_identifier or ""),
                    code_hash=make_password(code),
                    status=PhoneVerificationChallenge.Status.SENDING,
                    max_attempts=MAX_VERIFY_ATTEMPTS,
                    expires_at=now + timedelta(seconds=OTP_TTL_SECONDS),
                    send_reserved_at=now,
                )
        except PhoneVerificationThrottled:
            raise
        except (IntegrityError, ValidationError, ValueError) as exc:
            raise PhoneVerificationThrottled("A verification code was already requested. Please try again.") from exc

        try:
            message = aws_config.render_sms_otp_message(code)
        except ValueError as exc:
            _mark_challenge_delivery_failed(challenge.pk)
            raise PhoneVerificationDeliveryError("SMS message template is invalid.") from exc

        try:
            message_id = _publish_sms(
                phone_number=phone_number,
                message=message,
                aws_config=aws_config,
            )
        except Exception:
            # Preserve send_reserved_at even if marking the final state fails.
            _mark_challenge_delivery_failed(challenge.pk)
            raise

        try:
            finalized = _mark_challenge_sent(challenge.pk)
        except Exception:  # noqa: BLE001 - provider already accepted the message.
            logger.exception("Unable to finalize delivered SMS challenge %s", challenge.pk)
            finalized = False
        if (
            not finalized
            and not PhoneVerificationChallenge.objects.filter(
                pk=challenge.pk,
                status=PhoneVerificationChallenge.Status.SENDING,
            ).exists()
        ):
            raise PhoneVerificationDeliveryError("SMS challenge could not be finalized.")

    logger.info("Phone verification started: message_id=%s", message_id)
    return {"status": DEFAULT_STATUS, "challenge_id": str(challenge.pk)}


def check_phone_verification(
    phone_number: str | None,
    code: str,
    *,
    challenge_id=None,
    purpose: str = DEFAULT_PURPOSE,
    member=None,
    context_identifier: str | None = None,
    consume: bool = True,
    approved_callback=None,
):
    """
    Check and atomically consume a durable verification challenge.

    ``challenge_id`` is the preferred API. For one compatibility release callers
    may omit it and the latest pending challenge for ``phone_number`` is used.
    """
    # Keep the successful state transition and any caller-supplied completion
    # work in one transaction. Auth callers use this hook to create/resolve the
    # member and mint refresh tokens before the OTP consumption can commit.
    # Invalid outcomes leave the block normally so attempt/expiry mutations
    # commit before the public exception is raised.
    callback_result = None
    with transaction.atomic():
        challenge, outcome = _check_phone_verification(
            phone_number=phone_number,
            code=code,
            challenge_id=challenge_id,
            purpose=purpose,
            member=member,
            context_identifier=context_identifier,
            consume=consume,
        )
        if challenge is not None and approved_callback is not None:
            callback_result = approved_callback(challenge)
    if outcome == "throttled":
        raise PhoneVerificationThrottled("Too many failed attempts. Please request a new code.")
    if challenge is None:
        raise PhoneVerificationInvalid("Verification code is invalid or has expired.")
    logger.info("Phone verification approved")
    return callback_result if approved_callback is not None else challenge


@transaction.atomic
def _check_phone_verification(
    *,
    phone_number: str | None,
    code: str,
    challenge_id,
    purpose: str,
    member,
    context_identifier: str | None,
    consume: bool,
) -> tuple[PhoneVerificationChallenge | None, str]:
    queryset = PhoneVerificationChallenge.objects.select_for_update().filter(
        purpose=purpose,
        status__in=VERIFIABLE_STATUSES,
    )
    if member is not None:
        queryset = queryset.filter(member=member)
    if context_identifier is not None:
        queryset = queryset.filter(context_identifier=str(context_identifier))
    if challenge_id:
        try:
            parsed_challenge_id = UUID(str(challenge_id))
        except (ValidationError, ValueError, TypeError):
            return None, "invalid"
        queryset = queryset.filter(pk=parsed_challenge_id)
        if phone_number:
            queryset = queryset.filter(phone_number=phone_number)
    elif phone_number:
        queryset = queryset.filter(phone_number=phone_number).order_by("-created_at")
    else:
        return None, "invalid"

    challenge = queryset.first()
    if challenge is None:
        return None, "invalid"

    now = timezone.now()
    if challenge.expires_at <= now or challenge.attempts >= challenge.max_attempts:
        challenge.status = PhoneVerificationChallenge.Status.EXPIRED
        challenge.save(update_fields=["status", "updated_at"])
        return None, "throttled" if challenge.attempts >= challenge.max_attempts else "invalid"

    if not check_password(code, challenge.code_hash):
        challenge.attempts += 1
        if challenge.attempts >= challenge.max_attempts:
            challenge.status = PhoneVerificationChallenge.Status.EXPIRED
        challenge.save(update_fields=["attempts", "status", "updated_at"])
        return None, "throttled" if challenge.status == PhoneVerificationChallenge.Status.EXPIRED else "invalid"

    next_status = PhoneVerificationChallenge.Status.CONSUMED if consume else PhoneVerificationChallenge.Status.VERIFIED
    update_fields = {
        "status": next_status,
        "updated_at": now,
    }
    if consume:
        update_fields["consumed_at"] = now
    else:
        update_fields["verified_at"] = now
        update_fields["expires_at"] = now + timedelta(seconds=VERIFIED_GRANT_TTL_SECONDS)
    updated = PhoneVerificationChallenge.objects.filter(
        pk=challenge.pk,
        status__in=VERIFIABLE_STATUSES,
        expires_at__gt=now,
    ).update(**update_fields)
    if not updated:
        return None, "invalid"
    challenge.status = next_status
    if consume:
        challenge.consumed_at = now
    else:
        challenge.verified_at = now
        challenge.expires_at = update_fields["expires_at"]
    return challenge, "approved"


@transaction.atomic
def consume_verified_phone_challenge(
    *,
    phone_number: str,
    purpose: str,
    member,
    context_identifier: str,
    challenge_id=None,
    compatibility_context_identifiers: tuple[str, ...] = (),
) -> PhoneVerificationChallenge:
    """Consume a verified grant inside the caller's database transaction.

    Event registration uses this two-step form so code verification and form
    submission can be separate HTTP requests without falling back to cache.
    ``challenge_id`` may be omitted for one compatibility release.
    """
    allowed_contexts = (
        str(context_identifier),
        *(str(value) for value in compatibility_context_identifiers),
    )
    queryset = PhoneVerificationChallenge.objects.select_for_update().filter(
        phone_number=phone_number,
        purpose=purpose,
        member=member,
        context_identifier__in=allowed_contexts,
        status=PhoneVerificationChallenge.Status.VERIFIED,
    )
    if challenge_id:
        try:
            parsed_challenge_id = UUID(str(challenge_id))
        except (ValidationError, ValueError, TypeError) as exc:
            raise PhoneVerificationInvalid("Verification proof is invalid or has expired.") from exc
        queryset = queryset.filter(pk=parsed_challenge_id)
    else:
        queryset = queryset.order_by("-verified_at", "-created_at")

    challenge = queryset.first()
    now = timezone.now()
    if challenge is None or challenge.expires_at <= now:
        if challenge is not None:
            challenge.status = PhoneVerificationChallenge.Status.EXPIRED
            challenge.save(update_fields=["status", "updated_at"])
        raise PhoneVerificationInvalid("Verification proof is invalid or has expired.")

    updated = PhoneVerificationChallenge.objects.filter(
        pk=challenge.pk,
        status=PhoneVerificationChallenge.Status.VERIFIED,
        expires_at__gt=now,
    ).update(
        status=PhoneVerificationChallenge.Status.CONSUMED,
        consumed_at=now,
        updated_at=now,
    )
    if not updated:
        raise PhoneVerificationInvalid("Verification proof is invalid or has expired.")
    challenge.status = PhoneVerificationChallenge.Status.CONSUMED
    challenge.consumed_at = now
    return challenge


def publish_plain_sms(*, phone_number: str, message: str) -> str:
    """Send a plain SMS message via AWS End User Messaging (used by admin test-send)."""
    aws_config = _load_aws_config()
    if not aws_config.sns_configured:
        raise PhoneVerificationDeliveryError("SMS is not configured.")
    return _publish_sms(phone_number=phone_number, message=message, aws_config=aws_config)
