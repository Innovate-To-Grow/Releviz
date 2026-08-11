import uuid
from collections.abc import Mapping

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.core.models import BackgroundJob


def jobs_enabled() -> bool:
    return bool(getattr(settings, "BACKGROUND_JOBS_ENABLED", False))


def enqueue_job(
    *,
    kind: str,
    dedupe_key: str,
    payload: Mapping,
    can_retry_after_claim: bool = True,
    max_attempts: int = 5,
    available_at=None,
) -> tuple[BackgroundJob, bool]:
    """Create one durable job, returning the existing row on duplicate enqueue."""
    if not kind or not dedupe_key:
        raise ValueError("Background jobs require non-empty kind and dedupe_key values.")
    if not isinstance(payload, Mapping):
        raise TypeError("Background job payload must be a mapping.")
    with transaction.atomic():
        return BackgroundJob.objects.get_or_create(
            kind=kind,
            dedupe_key=dedupe_key,
            defaults={
                "payload": dict(payload),
                "can_retry_after_claim": can_retry_after_claim,
                "max_attempts": max(1, max_attempts),
                "available_at": available_at or timezone.now(),
            },
        )


def enqueue_notification_email(
    *,
    recipient: str,
    subject: str,
    template: str,
    context: dict,
    dedupe_key: str | None = None,
):
    """Queue a fire-and-forget notification email without exposing its body in logs."""
    payload = {
        "recipient": recipient,
        "subject": subject,
        "template": template,
        "context": context,
    }
    return enqueue_job(
        kind="authn.notification_email",
        # A job is idempotent across worker retries, but two identical security
        # events at different times must each notify the owner.
        dedupe_key=dedupe_key or str(uuid.uuid4()),
        payload=payload,
        can_retry_after_claim=False,
    )


def retry_job(job: BackgroundJob) -> bool:
    """Explicitly requeue a terminal job, including uncertain deliveries."""
    now = timezone.now()
    with transaction.atomic():
        current = (
            BackgroundJob.objects.select_for_update()
            .filter(
                pk=job.pk,
                status__in=[
                    BackgroundJob.Status.FAILED,
                    BackgroundJob.Status.UNCERTAIN,
                ],
            )
            .first()
        )
        if current is None:
            return False
        current.status = BackgroundJob.Status.RETRY
        current.available_at = now
        current.claim_token = None
        current.claimed_at = None
        current.provider_call_started_at = None
        current.completed_at = None
        current.last_error = ""
        current.updated_at = now
        current.save(
            update_fields=[
                "status",
                "available_at",
                "claim_token",
                "claimed_at",
                "provider_call_started_at",
                "completed_at",
                "last_error",
                "updated_at",
            ]
        )
        from .registry import notify_job_state

        # Keep the durable transition and any domain mirror in one transaction.
        # Other workers cannot observe RETRY until the recipient log is ready.
        notify_job_state(current)
        job.refresh_from_db()
    return True
