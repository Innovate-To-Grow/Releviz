from __future__ import annotations

import logging
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import timedelta
from email.utils import make_msgid
from threading import Lock
from urllib.parse import urlencode

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.db import close_old_connections, transaction
from django.db.models import Q
from django.utils import timezone

from apps.core.services.aws.crypto import decrypt_secret, encrypt_secret
from apps.mail.email_templates import render_branded_email
from apps.mail.models import EmailDeliveryJob, EmailMessageLog, EmailProviderConfig
from apps.mail.terminal_output import print_email_to_terminal

logger = logging.getLogger(__name__)


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
    message_id: str = "",
) -> EmailMultiAlternatives:
    message = EmailMultiAlternatives(
        subject=_clean_header(subject),
        body=body,
        from_email=from_email,
        to=recipients,
        reply_to=[reply_to] if reply_to else None,
        headers={"Message-ID": _clean_header(message_id) or make_msgid(domain="releviz.local")},
    )
    if html_body:
        message.attach_alternative(html_body, "text/html")
    for attachment in attachments or []:
        message.attach(attachment.filename, attachment.content, attachment.mimetype)
    return message


def _send_with_ses(message: EmailMultiAlternatives) -> str:
    from apps.core.services.aws.credentials import (
        AwsCredentialsError,
        resolve_aws_credentials,
    )

    try:
        creds = resolve_aws_credentials("ses")
    except AwsCredentialsError as exc:
        raise EmailDeliveryError(
            "AWS SES credentials are not configured. Add an active AWS Credential Config first."
        ) from exc

    try:
        import boto3
    except ImportError as exc:  # pragma: no cover - dependency is installed in supported envs
        raise EmailDeliveryError("boto3 is required for AWS SES email delivery.") from exc

    client = boto3.client(
        "ses",
        region_name=creds.region,
        aws_access_key_id=creds.access_key_id,
        aws_secret_access_key=creds.secret_access_key,
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
    delivery_job=None,
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
                delivery_job=delivery_job,
            )
            for recipient in recipients
        ]
    )


def _safe_log_each(**kwargs) -> None:
    try:
        _log_each(**kwargs)
    except Exception:  # noqa: BLE001 - delivery state remains authoritative
        logger.exception(
            "email_message_log_failed",
            extra={
                "message_type": kwargs.get("message_type"),
                "recipient_count": len(kwargs.get("recipients") or []),
            },
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
    message_id: str = "",
    delivery_job=None,
) -> str:
    clean_recipients = [recipient.strip().lower() for recipient in recipients if recipient.strip()]
    if not clean_recipients:
        raise EmailDeliveryError("At least one recipient is required.")

    if not html_body:
        html_body = render_branded_email(
            title=_clean_header(subject),
            preheader=_clean_header(subject),
            paragraphs=(body,),
        )

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
        message_id=message_id,
    )

    try:
        if getattr(settings, "PRINT_EMAILS_TO_TERMINAL", False):
            html_alternative = next(
                (
                    content
                    for content, mimetype in message.alternatives
                    if mimetype == "text/html"
                ),
                "",
            )
            print_email_to_terminal(
                subject=message.subject,
                from_email=message.from_email,
                recipients=list(message.to),
                body=message.body,
                html_body=html_alternative,
                reply_to=", ".join(message.reply_to or []),
                message_id=message.extra_headers.get("Message-ID", ""),
                attachment_names=[attachment[0] for attachment in message.attachments],
                message_type=message_type,
            )
            provider_message_id = "terminal"
        elif getattr(settings, "USE_SES_EMAIL_PROVIDER", False):
            if config is None:
                raise EmailDeliveryError("No active AWS SES email provider is configured.")
            provider_message_id = _send_with_ses(message)
        else:
            sent_count = message.send(fail_silently=False)
            if sent_count == 0:
                raise EmailDeliveryError("Django email backend did not send the message.")
            provider_message_id = ""
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
        _safe_log_each(
            recipients=clean_recipients,
            subject=subject,
            message_type=message_type,
            status=EmailMessageLog.Status.FAILED,
            error=error,
            event=event,
            invitation=invitation,
            delivery_job=delivery_job,
        )
        if isinstance(exc, EmailDeliveryError):
            raise
        raise EmailDeliveryError(error) from exc

    _safe_log_each(
        recipients=clean_recipients,
        subject=subject,
        message_type=message_type,
        status=EmailMessageLog.Status.SENT,
        provider_message_id=provider_message_id,
        event=event,
        invitation=invitation,
        delivery_job=delivery_job,
    )
    return provider_message_id


def _serialize_attachments(attachments: list[EmailAttachment] | None) -> list[dict]:
    return [
        {
            "filename": attachment.filename,
            "content": attachment.content,
            "mimetype": attachment.mimetype,
        }
        for attachment in attachments or []
    ]


def _deserialize_attachments(attachments: list[dict]) -> list[EmailAttachment]:
    return [
        EmailAttachment(
            filename=str(attachment["filename"]),
            content=str(attachment["content"]),
            mimetype=str(attachment["mimetype"]),
        )
        for attachment in attachments
    ]


def enqueue_email_job(
    *,
    idempotency_key: str,
    message_type: str,
    recipient: str,
    subject: str,
    body: str,
    message_id: str,
    event=None,
    invitation=None,
    member=None,
    auth_challenge=None,
    html_body: str = "",
    attachments: list[EmailAttachment] | None = None,
    max_attempts: int = 5,
    encrypt_content: bool = False,
) -> tuple[EmailDeliveryJob, bool]:
    normalized_recipient = recipient.strip().lower()
    if not normalized_recipient:
        raise ValueError("An email delivery job requires a recipient.")
    if event is None and member is None:
        raise ValueError("An email delivery job must belong to an event or member.")
    stored_body = encrypt_secret(body) if encrypt_content else body
    stored_html_body = encrypt_secret(html_body) if encrypt_content and html_body else html_body
    defaults = {
        "message_type": message_type,
        "recipient": normalized_recipient,
        "subject": _clean_header(subject),
        "body": stored_body,
        "html_body": stored_html_body,
        "content_encrypted": encrypt_content,
        "attachments": _serialize_attachments(attachments),
        "message_id": _clean_header(message_id),
        "event": event,
        "invitation": invitation,
        "member": member,
        "auth_challenge": auth_challenge,
        "max_attempts": max_attempts,
    }
    job, created = EmailDeliveryJob.objects.get_or_create(
        idempotency_key=idempotency_key,
        defaults=defaults,
    )
    if not created:
        expected = {
            field: value for field, value in defaults.items() if field not in {"body", "html_body"}
        }
        actual_body = decrypt_secret(job.body) if job.content_encrypted else job.body
        actual_html_body = (
            decrypt_secret(job.html_body)
            if job.content_encrypted and job.html_body
            else job.html_body
        )
        if (
            actual_body != body
            or actual_html_body != html_body
            or any(getattr(job, field) != value for field, value in expected.items())
        ):
            raise ValueError("Email delivery idempotency key was reused with different content.")
    return job, created


def _delivery_content(job: EmailDeliveryJob) -> tuple[str, str]:
    if not job.content_encrypted:
        return job.body, job.html_body
    body = decrypt_secret(job.body)
    html_body = decrypt_secret(job.html_body) if job.html_body else ""
    if (job.body and not body) or (job.html_body and not html_body):
        raise EmailDeliveryError("Encrypted email content could not be decrypted.")
    return body, html_body


def _final_cancellation_predecessor(job: EmailDeliveryJob):
    if job.message_type != EmailMessageLog.MessageType.FINAL_CANCELLATION or job.event_id is None:
        return None, False
    parts = job.idempotency_key.split(":")
    if len(parts) != 4 or parts[0] != "final-cancellation":
        return None, False
    try:
        confirmation_sequence = int(parts[2]) - 1
    except ValueError:
        return None, False
    prefix = f"final-confirmation:{parts[1]}:{confirmation_sequence}:"
    predecessor = (
        EmailDeliveryJob.objects.filter(
            event_id=job.event_id,
            recipient=job.recipient,
            message_type=EmailMessageLog.MessageType.FINAL_CONFIRMATION,
            idempotency_key__startswith=prefix,
        )
        .order_by("-created_at")
        .first()
    )
    return predecessor, True


def _claim_email_job(job_id, *, now) -> tuple[EmailDeliveryJob | None, uuid.UUID | None]:
    stale_before = now - timedelta(minutes=15)
    with transaction.atomic():
        job = EmailDeliveryJob.objects.select_for_update().filter(pk=job_id).first()
        if job is None or job.status in {
            EmailDeliveryJob.Status.SENT,
            EmailDeliveryJob.Status.PERMANENT_FAILURE,
            EmailDeliveryJob.Status.CANCELED,
        }:
            return job, None
        if job.event_id is not None and job.message_type in {
            EmailMessageLog.MessageType.INVITATION,
            EmailMessageLog.MessageType.REMINDER,
        }:
            from apps.scheduling.models import Event

            event_status = (
                Event.objects.filter(pk=job.event_id).values_list("status", flat=True).first()
            )
            if event_status != Event.Status.ACTIVE:
                job.status = EmailDeliveryJob.Status.CANCELED
                job.last_error = "The event is no longer active."
                job.reset_lock()
                job.save(
                    update_fields=[
                        "status",
                        "last_error",
                        "locked_at",
                        "lock_token",
                        "updated_at",
                    ]
                )
                return job, None
        predecessor, has_dependency = _final_cancellation_predecessor(job)
        if has_dependency:
            if predecessor is not None and predecessor.status == EmailDeliveryJob.Status.PROCESSING:
                job.next_attempt_at = now + timedelta(seconds=5)
                job.save(update_fields=["next_attempt_at", "updated_at"])
                return job, None
            if predecessor is None or predecessor.status != EmailDeliveryJob.Status.SENT:
                job.status = EmailDeliveryJob.Status.CANCELED
                job.last_error = "The preceding calendar request was not delivered."
                job.reset_lock()
                job.save(
                    update_fields=[
                        "status",
                        "last_error",
                        "locked_at",
                        "lock_token",
                        "updated_at",
                    ]
                )
                return job, None
        if job.auth_challenge_id:
            from apps.authn.models import EmailAuthChallenge

            challenge = (
                EmailAuthChallenge.objects.filter(pk=job.auth_challenge_id)
                .values("status", "expires_at")
                .first()
            )
            if (
                challenge is None
                or challenge["status"] != EmailAuthChallenge.Status.PENDING
                or challenge["expires_at"] <= now
            ):
                if challenge and challenge["status"] == EmailAuthChallenge.Status.PENDING:
                    EmailAuthChallenge.objects.filter(pk=job.auth_challenge_id).update(
                        status=EmailAuthChallenge.Status.EXPIRED,
                        updated_at=now,
                    )
                job.status = EmailDeliveryJob.Status.CANCELED
                job.last_error = "Authentication challenge is no longer active."
                job.reset_lock()
                job.save(
                    update_fields=[
                        "status",
                        "last_error",
                        "locked_at",
                        "lock_token",
                        "updated_at",
                    ]
                )
                return job, None
        is_due = (
            job.status in {EmailDeliveryJob.Status.PENDING, EmailDeliveryJob.Status.RETRY}
            and job.next_attempt_at <= now
        )
        is_stale = job.status == EmailDeliveryJob.Status.PROCESSING and (
            job.locked_at is None or job.locked_at <= stale_before
        )
        if not is_due and not is_stale:
            return job, None
        if job.attempt_count >= job.max_attempts:
            job.status = EmailDeliveryJob.Status.PERMANENT_FAILURE
            job.last_error = job.last_error or "Maximum delivery attempts reached."
            job.reset_lock()
            job.save(
                update_fields=[
                    "status",
                    "last_error",
                    "locked_at",
                    "lock_token",
                    "updated_at",
                ]
            )
            return job, None
        token = job.new_lock_token()
        job.status = EmailDeliveryJob.Status.PROCESSING
        job.attempt_count += 1
        job.locked_at = now
        job.lock_token = token
        job.save(
            update_fields=[
                "status",
                "attempt_count",
                "locked_at",
                "lock_token",
                "updated_at",
            ]
        )
        return job, token


def dispatch_email_job(job_id, *, now=None) -> dict:
    current_time = now or timezone.now()
    job, token = _claim_email_job(job_id, now=current_time)
    if job is None:
        return {"attempted": False, "status": "missing"}
    if token is None:
        return {"attempted": False, "status": job.status}

    try:
        body, html_body = _delivery_content(job)
        provider_message_id = send_email_message(
            subject=job.subject,
            body=body,
            html_body=html_body,
            recipients=[job.recipient],
            message_type=job.message_type,
            attachments=_deserialize_attachments(job.attachments),
            event=job.event,
            invitation=job.invitation,
            message_id=job.message_id,
            delivery_job=job,
        )
    except Exception as exc:  # noqa: BLE001 - isolate every durable job attempt
        completion_time = now or timezone.now()
        with transaction.atomic():
            claimed = EmailDeliveryJob.objects.select_for_update().get(pk=job.pk)
            if claimed.lock_token != token:
                return {"attempted": True, "status": claimed.status}
            claimed.last_error = str(exc)
            claimed.reset_lock()
            if claimed.attempt_count >= claimed.max_attempts:
                claimed.status = EmailDeliveryJob.Status.PERMANENT_FAILURE
            else:
                claimed.status = EmailDeliveryJob.Status.RETRY
                claimed.next_attempt_at = completion_time + timedelta(
                    minutes=2 ** (claimed.attempt_count - 1)
                )
            claimed.save(
                update_fields=[
                    "status",
                    "next_attempt_at",
                    "last_error",
                    "locked_at",
                    "lock_token",
                    "updated_at",
                ]
            )
        log_failure = logger.warning if isinstance(exc, EmailDeliveryError) else logger.exception
        log_failure(
            "email_delivery_failed"
            if isinstance(exc, EmailDeliveryError)
            else "email_delivery_unexpected_failure",
            extra={
                "delivery_job_id": str(job.pk),
                "event_id": str(job.event_id) if job.event_id else None,
                "member_id": str(job.member_id) if job.member_id else None,
                "message_type": job.message_type,
                "attempt": job.attempt_count,
                "status": claimed.status,
            },
        )
        return {"attempted": True, "status": claimed.status}

    completion_time = now or timezone.now()
    with transaction.atomic():
        claimed = EmailDeliveryJob.objects.select_for_update().get(pk=job.pk)
        if claimed.lock_token != token:
            return {"attempted": True, "status": claimed.status}
        claimed.status = EmailDeliveryJob.Status.SENT
        claimed.sent_at = completion_time
        claimed.provider_message_id = provider_message_id
        claimed.last_error = ""
        claimed.reset_lock()
        claimed.save(
            update_fields=[
                "status",
                "sent_at",
                "provider_message_id",
                "last_error",
                "locked_at",
                "lock_token",
                "updated_at",
            ]
        )
        if claimed.auth_challenge_id:
            from apps.authn.models import EmailAuthChallenge

            EmailAuthChallenge.objects.filter(
                pk=claimed.auth_challenge_id,
                status=EmailAuthChallenge.Status.PENDING,
            ).update(
                expires_at=completion_time + settings.AUTH_CHALLENGE_VERIFICATION_LIFETIME,
                last_sent_at=completion_time,
                updated_at=completion_time,
            )
        if claimed.invitation_id:
            from apps.scheduling.models import EventInvitation

            if claimed.message_type == EmailMessageLog.MessageType.INVITATION:
                EventInvitation.objects.filter(
                    pk=claimed.invitation_id,
                    first_sent_at__isnull=True,
                ).update(
                    first_sent_at=completion_time,
                    updated_at=completion_time,
                )
                EventInvitation.objects.filter(pk=claimed.invitation_id).update(
                    last_sent_at=completion_time,
                    updated_at=completion_time,
                )
            elif claimed.message_type == EmailMessageLog.MessageType.REMINDER:
                EventInvitation.objects.filter(pk=claimed.invitation_id).update(
                    reminder_sent_at=completion_time,
                    updated_at=completion_time,
                )
    logger.info(
        "email_delivery_sent",
        extra={
            "delivery_job_id": str(job.pk),
            "event_id": str(job.event_id) if job.event_id else None,
            "member_id": str(job.member_id) if job.member_id else None,
            "message_type": job.message_type,
            "attempt": job.attempt_count,
        },
    )
    return {"attempted": True, "status": EmailDeliveryJob.Status.SENT}


def email_delivery_summary(jobs) -> dict:
    statuses = {status: 0 for status in EmailDeliveryJob.Status.values}
    total = 0
    for job in jobs:
        total += 1
        statuses[job.status] += 1
    return {
        "total": total,
        "pending": statuses[EmailDeliveryJob.Status.PENDING],
        "processing": statuses[EmailDeliveryJob.Status.PROCESSING],
        "retry": statuses[EmailDeliveryJob.Status.RETRY],
        "sent": statuses[EmailDeliveryJob.Status.SENT],
        "permanentFailure": statuses[EmailDeliveryJob.Status.PERMANENT_FAILURE],
        "canceled": statuses[EmailDeliveryJob.Status.CANCELED],
    }


class _DispatchRateLimiter:
    def __init__(self, rate_per_second: float | None):
        self.interval = 1 / rate_per_second if rate_per_second else 0.0
        self.next_start = 0.0
        self.lock = Lock()

    def wait(self, stop_event=None) -> bool:
        if not self.interval:
            return not (stop_event is not None and stop_event.is_set())
        with self.lock:
            current = time.monotonic()
            scheduled = max(current, self.next_start)
            self.next_start = scheduled + self.interval
        delay = max(0.0, scheduled - current)
        if stop_event is not None:
            return not stop_event.wait(delay)
        if delay:
            time.sleep(delay)
        return True


def _dispatch_email_worker(
    job_id,
    *,
    now,
    limiter,
    stop_event=None,
    manage_connections: bool = True,
) -> dict:
    if not limiter.wait(stop_event):
        return {"attempted": False, "status": "stopped"}
    if manage_connections:
        close_old_connections()
    try:
        try:
            return dispatch_email_job(job_id, now=now)
        except Exception:  # noqa: BLE001 - one poisoned job must not stop the worker
            logger.exception(
                "email_delivery_job_unhandled",
                extra={"delivery_job_id": str(job_id)},
            )
            return {"attempted": False, "status": "error"}
    finally:
        if manage_connections:
            close_old_connections()


def dispatch_due_email_jobs(
    *,
    limit: int = 100,
    now=None,
    concurrency: int = 1,
    rate_limit_per_second: float | None = None,
    stop_event=None,
) -> dict:
    if concurrency < 1:
        raise ValueError("concurrency must be at least 1")
    if rate_limit_per_second is not None and rate_limit_per_second <= 0:
        raise ValueError("rate_limit_per_second must be positive")
    current_time = now or timezone.now()
    stale_before = current_time - timedelta(minutes=15)
    job_ids = list(
        EmailDeliveryJob.objects.filter(
            Q(
                status__in=[
                    EmailDeliveryJob.Status.PENDING,
                    EmailDeliveryJob.Status.RETRY,
                ],
                next_attempt_at__lte=current_time,
            )
            | Q(
                status=EmailDeliveryJob.Status.PROCESSING,
                locked_at__lte=stale_before,
            )
            | Q(
                status=EmailDeliveryJob.Status.PROCESSING,
                locked_at__isnull=True,
            )
        )
        .order_by("next_attempt_at", "created_at")
        .values_list("pk", flat=True)[:limit]
    )
    summary = {
        "attempted": 0,
        "sent": 0,
        "retry": 0,
        "permanentFailure": 0,
        "canceled": 0,
    }
    limiter = _DispatchRateLimiter(rate_limit_per_second)
    if concurrency == 1:
        results = (
            _dispatch_email_worker(
                job_id,
                now=now,
                limiter=limiter,
                stop_event=stop_event,
                manage_connections=False,
            )
            for job_id in job_ids
        )
    else:
        executor = ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="email-job")
        results = executor.map(
            lambda job_id: _dispatch_email_worker(
                job_id,
                now=now,
                limiter=limiter,
                stop_event=stop_event,
            ),
            job_ids,
        )
    try:
        for result in results:
            if result["status"] == EmailDeliveryJob.Status.CANCELED:
                summary["canceled"] += 1
            if not result["attempted"]:
                continue
            summary["attempted"] += 1
            if result["status"] == EmailDeliveryJob.Status.SENT:
                summary["sent"] += 1
            elif result["status"] == EmailDeliveryJob.Status.RETRY:
                summary["retry"] += 1
            elif result["status"] == EmailDeliveryJob.Status.PERMANENT_FAILURE:
                summary["permanentFailure"] += 1
    finally:
        if concurrency > 1:
            executor.shutdown(wait=True, cancel_futures=True)
    return summary
