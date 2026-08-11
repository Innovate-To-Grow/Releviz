import logging
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from apps.core.models import BackgroundJob

from .registry import notify_job_state, resolve_stale_job_state

logger = logging.getLogger(__name__)


def recover_stale_jobs(*, stale_after: timedelta = timedelta(minutes=10)) -> dict[str, int]:
    """Recover abandoned claims without automatically duplicating deliveries."""
    cutoff = timezone.now() - stale_after
    stale_ids = list(
        BackgroundJob.objects.filter(
            status=BackgroundJob.Status.PROCESSING,
            claimed_at__lt=cutoff,
        ).values_list("pk", flat=True)
    )
    counts = {
        BackgroundJob.Status.SUCCEEDED: 0,
        BackgroundJob.Status.RETRY: 0,
        BackgroundJob.Status.FAILED: 0,
        BackgroundJob.Status.UNCERTAIN: 0,
    }
    for job_id in stale_ids:
        try:
            recovered_status = _recover_stale_job(job_id=job_id, cutoff=cutoff)
        except Exception:  # noqa: BLE001 - one broken mirror must not block other stale jobs.
            logger.exception("Unable to atomically recover background job %s", job_id)
            continue
        if recovered_status is not None:
            counts[recovered_status] += 1
    return {
        "completed": counts[BackgroundJob.Status.SUCCEEDED],
        "retried": counts[BackgroundJob.Status.RETRY],
        "failed": counts[BackgroundJob.Status.FAILED],
        "uncertain": counts[BackgroundJob.Status.UNCERTAIN],
    }


def _recover_stale_job(*, job_id, cutoff):
    """Recover one job and its domain mirror under the same row locks."""

    with transaction.atomic():
        job = (
            BackgroundJob.objects.select_for_update()
            .filter(
                pk=job_id,
                status=BackgroundJob.Status.PROCESSING,
                claimed_at__lt=cutoff,
            )
            .first()
        )
        if job is None:
            return None

        target_status, last_error = _recovery_target(job)
        now = timezone.now()
        job.status = target_status
        job.claim_token = None
        job.claimed_at = None
        job.last_error = last_error
        job.updated_at = now
        if target_status == BackgroundJob.Status.RETRY:
            job.available_at = now
            job.provider_call_started_at = None
            job.completed_at = None
        else:
            job.completed_at = now
        job.save(
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

        # The stale-state resolver locks a delivery log before this transition,
        # and its mirror runs before commit. A returning provider call therefore
        # either wins first (and recovery records success) or loses its log CAS.
        notify_job_state(job)
        return target_status


def _recovery_target(job: BackgroundJob) -> tuple[str, str]:
    resolved_state = resolve_stale_job_state(job)
    if resolved_state == BackgroundJob.Status.SUCCEEDED:
        return BackgroundJob.Status.SUCCEEDED, ""
    if resolved_state == BackgroundJob.Status.RETRY:
        return _retry_or_exhausted(job)
    if resolved_state == BackgroundJob.Status.FAILED:
        return BackgroundJob.Status.FAILED, "Provider definitively rejected the delivery."
    if resolved_state == BackgroundJob.Status.UNCERTAIN:
        return BackgroundJob.Status.UNCERTAIN, (
            "Worker stopped after the provider call began; delivery outcome is uncertain. "
            "Review before manually retrying."
        )
    if job.can_retry_after_claim or job.provider_call_started_at is None:
        return _retry_or_exhausted(job)
    return BackgroundJob.Status.UNCERTAIN, (
        "Worker stopped after the provider call began; delivery outcome is uncertain. Review before manually retrying."
    )


def _retry_or_exhausted(job: BackgroundJob) -> tuple[str, str]:
    if job.attempts < job.max_attempts:
        return BackgroundJob.Status.RETRY, "Worker claim expired before completion."
    return BackgroundJob.Status.FAILED, "Maximum attempts reached after the worker claim expired."
