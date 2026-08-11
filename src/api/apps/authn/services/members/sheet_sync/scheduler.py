import logging
import threading
import uuid
from datetime import timedelta

from django.db import close_old_connections, transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

MEMBER_SHEET_JOB_KIND = "authn.member_sheet_sync"
DEBOUNCE_SECONDS = 15
_sync_timer: threading.Timer | None = None
_sync_lock = threading.Lock()


def schedule_member_sync() -> None:
    from apps.authn.models import MemberSheetSyncConfig

    config = MemberSheetSyncConfig.load()
    if not config.is_configured or not config.auto_sync_enabled:
        return

    from apps.core.services.background_jobs import jobs_enabled

    if jobs_enabled():
        _enqueue_durable_sync(immediate=False)
    else:
        _schedule_in_process_sync(delay=DEBOUNCE_SECONDS)


def schedule_immediate_sync() -> None:
    from apps.core.services.background_jobs import jobs_enabled

    if jobs_enabled():
        _enqueue_durable_sync(immediate=True)
    else:
        _schedule_in_process_sync(delay=0)


def _schedule_in_process_sync(*, delay: float) -> None:
    """Use the pre-outbox debounce timer without blocking the request thread."""

    global _sync_timer
    with _sync_lock:
        if _sync_timer is not None:
            _sync_timer.cancel()
        _sync_timer = None
        timer = None
        try:
            timer = threading.Timer(delay, _run_in_process_sync)
            timer.daemon = True
            _sync_timer = timer
            timer.start()
        except Exception:  # noqa: BLE001 - a best-effort timer must not break the caller.
            if _sync_timer is timer:
                _sync_timer = None
            logger.exception("Unable to start the member sheet sync timer")


def _run_in_process_sync() -> None:
    global _sync_timer
    with _sync_lock:
        if _sync_timer is not threading.current_thread():
            # A newer debounce timer replaced this one while it was waking up.
            return
        _sync_timer = None
    close_old_connections()
    try:
        _flush_pending_sync()
    finally:
        close_old_connections()


def _enqueue_durable_sync(*, immediate: bool):
    """Coalesce queued full-sync work without losing writes during a claim."""
    from apps.core.models import BackgroundJob
    from apps.core.services.background_jobs import enqueue_job

    available_at = timezone.now()
    if not immediate:
        available_at += timedelta(seconds=DEBOUNCE_SECONDS)

    with transaction.atomic():
        queued = (
            BackgroundJob.objects.select_for_update()
            .filter(
                kind=MEMBER_SHEET_JOB_KIND,
                status__in=[BackgroundJob.Status.PENDING, BackgroundJob.Status.RETRY],
            )
            .order_by("created_at")
            .first()
        )
        if queued is not None:
            queued.available_at = available_at
            queued.last_error = ""
            queued.save(update_fields=["available_at", "last_error", "updated_at"])
            return queued
        job, _created = enqueue_job(
            kind=MEMBER_SHEET_JOB_KIND,
            dedupe_key=str(uuid.uuid4()),
            payload={},
            can_retry_after_claim=True,
            available_at=available_at,
        )
        return job


def _flush_pending_sync(*, raise_errors: bool = False) -> None:
    try:
        from apps.authn.models import MemberSheetSyncLog
        from apps.authn.services.members.sheet_sync import sync_members_to_sheet

        sync_members_to_sheet(sync_type=MemberSheetSyncLog.SyncType.DEBOUNCED)
    except Exception:
        logger.exception("Member sheet sync failed.")
        if raise_errors:
            raise
