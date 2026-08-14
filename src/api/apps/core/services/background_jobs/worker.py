import logging
import re
from datetime import timedelta

from django.db import OperationalError, connection, transaction
from django.utils import timezone
from gspread.exceptions import APIError as GspreadAPIError

from apps.core.models import BackgroundJob

from .registry import get_handler, notify_job_state

logger = logging.getLogger(__name__)

_ERROR_MAX_LENGTH = 500
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


class TransientJobError(RuntimeError):
    """A known temporary failure that is safe to retry."""


class PermanentJobError(RuntimeError):
    """A definitive failure that must not be retried automatically."""


class UncertainJobError(RuntimeError):
    """A provider call may have succeeded and must be reviewed manually."""


class JobClaimLost(RuntimeError):
    """The worker no longer owns a job and must not call an external provider."""


def _safe_error(exc: BaseException) -> str:
    text = _CONTROL_RE.sub(" ", str(exc)).strip()
    return (text or exc.__class__.__name__)[:_ERROR_MAX_LENGTH]


def _exception_chain(exc: BaseException):
    seen = set()
    current = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def _is_known_transient(exc: BaseException) -> bool:
    transient_names = {
        "ConnectTimeout",
        "ConnectionClosedError",
        "ConnectionError",
        "EndpointConnectionError",
        "ReadTimeout",
        "ReadTimeoutError",
        "ServiceUnavailable",
        "ThrottlingException",
        "Timeout",
    }
    for item in _exception_chain(exc):
        if (
            isinstance(item, TransientJobError | OperationalError | TimeoutError | ConnectionError)
            or item.__class__.__name__ in transient_names
        ):
            return True
        if isinstance(item, GspreadAPIError):
            status_code = getattr(getattr(item, "response", None), "status_code", None)
            if status_code in {408, 429} or (
                isinstance(status_code, int) and 500 <= status_code <= 599
            ):
                return True
    return False


def claim_jobs(*, batch_size: int = 10) -> list[BackgroundJob]:
    """Atomically claim an available batch using SKIP LOCKED on PostgreSQL."""
    now = timezone.now()
    with transaction.atomic():
        queryset = BackgroundJob.objects.filter(
            status__in=[BackgroundJob.Status.PENDING, BackgroundJob.Status.RETRY],
            available_at__lte=now,
        ).order_by("available_at", "created_at")
        if connection.features.has_select_for_update:
            queryset = queryset.select_for_update(
                skip_locked=connection.features.has_select_for_update_skip_locked
            )
        jobs = list(queryset[: max(1, batch_size)])
        for job in jobs:
            job.status = BackgroundJob.Status.PROCESSING
            job.claim_token = BackgroundJob.new_claim_token()
            job.claimed_at = now
            job.provider_call_started_at = None
            job.attempts += 1
            job.last_error = ""
            job.save(
                update_fields=[
                    "status",
                    "claim_token",
                    "claimed_at",
                    "provider_call_started_at",
                    "attempts",
                    "last_error",
                    "updated_at",
                ]
            )
        return jobs


def _complete(job: BackgroundJob) -> None:
    now = timezone.now()
    updated = BackgroundJob.objects.filter(
        pk=job.pk,
        status=BackgroundJob.Status.PROCESSING,
        claim_token=job.claim_token,
    ).update(
        status=BackgroundJob.Status.SUCCEEDED,
        completed_at=now,
        claim_token=None,
        claimed_at=None,
        last_error="",
        updated_at=now,
    )
    if updated:
        job.refresh_from_db()
        try:
            notify_job_state(job)
        except Exception:  # noqa: BLE001 - mirror failure must not kill the worker.
            logger.exception("Unable to mirror completed state for background job %s", job.pk)


def _fail(job: BackgroundJob, exc: BaseException) -> None:
    job.refresh_from_db(fields=["provider_call_started_at", "attempts", "max_attempts"])
    now = timezone.now()
    error = _safe_error(exc)
    chain = tuple(_exception_chain(exc))
    explicitly_transient = any(isinstance(item, TransientJobError) for item in chain)
    explicitly_permanent = any(isinstance(item, PermanentJobError) for item in chain)
    explicitly_uncertain = any(isinstance(item, UncertainJobError) for item in chain)
    if explicitly_transient:
        if job.attempts < job.max_attempts:
            status = BackgroundJob.Status.RETRY
            delay = min(3600, 2 ** max(0, job.attempts - 1) * 15)
            available_at = now + timedelta(seconds=delay)
        else:
            status = BackgroundJob.Status.FAILED
            available_at = job.available_at
    elif explicitly_permanent:
        status = BackgroundJob.Status.FAILED
        available_at = job.available_at
    elif explicitly_uncertain or (
        job.provider_call_started_at is not None and not job.can_retry_after_claim
    ):
        status = BackgroundJob.Status.UNCERTAIN
        available_at = job.available_at
    elif _is_known_transient(exc) and job.attempts < job.max_attempts:
        status = BackgroundJob.Status.RETRY
        delay = min(3600, 2 ** max(0, job.attempts - 1) * 15)
        available_at = now + timedelta(seconds=delay)
    else:
        status = BackgroundJob.Status.FAILED
        available_at = job.available_at
    updated = BackgroundJob.objects.filter(
        pk=job.pk,
        status=BackgroundJob.Status.PROCESSING,
        claim_token=job.claim_token,
    ).update(
        status=status,
        available_at=available_at,
        completed_at=now
        if status in {BackgroundJob.Status.FAILED, BackgroundJob.Status.UNCERTAIN}
        else None,
        claim_token=None,
        claimed_at=None,
        last_error=error,
        updated_at=now,
    )
    if updated:
        job.refresh_from_db()
        try:
            notify_job_state(job)
        except Exception:  # noqa: BLE001 - mirror failure must not kill the worker.
            logger.exception("Unable to mirror failed state for background job %s", job.pk)


def process_claimed_job(job: BackgroundJob) -> bool:
    try:
        get_handler(job.kind)(job)
    except Exception as exc:  # noqa: BLE001 - job boundary must persist every failure.
        logger.exception("Background job %s (%s) failed", job.pk, job.kind)
        _fail(job, exc)
        return False
    _complete(job)
    return True
