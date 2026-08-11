import json
import logging
import signal
import time

from django.conf import settings
from django.core.management.base import BaseCommand

from apps.authn.services.security.rsa_manager import purge_retired_auth_keypairs
from apps.core.services.background_jobs import (
    claim_jobs,
    process_claimed_job,
    publish_worker_metrics,
    recover_stale_jobs,
    worker_metrics,
)

logger = logging.getLogger(__name__)


def schedule_startup_reconciliation() -> bool:
    """Bootstrap edge rules once this deployment's durable worker is online."""

    if not getattr(settings, "BACKGROUND_JOBS_ENABLED", False):
        return False
    if not str(getattr(settings, "AMPLIFY_APP_ID", "") or "").strip():
        return False

    try:
        # Local import keeps the generic queue reusable without making the core
        # app import CMS models during Django startup.
        from apps.cms.services.amplify.amplify_redirects import schedule_amplify_redirect_sync

        job = schedule_amplify_redirect_sync(immediate=True)
    except Exception:  # noqa: BLE001 - startup scheduling must not stop delivery.
        logger.exception("Could not schedule startup Amplify reconciliation")
        return False

    if job is not None:
        logger.info("Scheduled startup Amplify reconciliation")
        return True
    return False


class Command(BaseCommand):
    help = "Run the PostgreSQL-backed durable background-job worker."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="Claim one batch and exit.")
        parser.add_argument("--batch-size", type=int, default=10)
        parser.add_argument("--poll-seconds", type=float, default=5.0)
        parser.add_argument("--stale-minutes", type=int, default=10)
        parser.add_argument("--key-purge-seconds", type=int, default=3600)

    def handle(self, *args, **options):
        stopping = False

        def request_stop(_signum, _frame):
            nonlocal stopping
            stopping = True

        signal.signal(signal.SIGTERM, request_stop)
        signal.signal(signal.SIGINT, request_stop)
        poll_seconds = min(30.0, max(0.25, options["poll_seconds"]))
        batch_size = max(1, options["batch_size"])
        key_purge_seconds = max(300, options.get("key_purge_seconds", 3600))
        next_key_purge_at = 0.0
        schedule_startup_reconciliation()

        while not stopping:
            from datetime import timedelta

            now_monotonic = time.monotonic()
            if now_monotonic >= next_key_purge_at:
                try:
                    purged_row_count = purge_retired_auth_keypairs()
                    if purged_row_count:
                        # Keep key material and values derived from the key store
                        # out of logs. The static event is enough for operators;
                        # detailed counts belong in controlled metrics.
                        logger.info("Purged retired RSA keypair rows")
                except Exception:  # noqa: BLE001 - maintenance must not stop delivery.
                    logger.exception("Retired RSA key purge failed")
                finally:
                    next_key_purge_at = now_monotonic + key_purge_seconds

            processed_jobs = 0
            try:
                recover_stale_jobs(stale_after=timedelta(minutes=max(1, options["stale_minutes"])))
            except Exception:  # noqa: BLE001 - one maintenance failure must not terminate the worker.
                logger.exception("Background worker maintenance/claim cycle failed")
            else:
                # Claim immediately before execution instead of reserving a whole
                # batch. If a shutdown signal arrives while one job is running,
                # later jobs remain pending and do not consume an attempt merely
                # because this worker is stopping.
                for _index in range(batch_size):
                    if stopping:
                        break
                    try:
                        jobs = claim_jobs(batch_size=1)
                    except Exception:  # noqa: BLE001 - retry the claim on the next cycle.
                        logger.exception("Background worker maintenance/claim cycle failed")
                        break
                    if not jobs:
                        break
                    job = jobs[0]
                    processed_jobs += 1
                    try:
                        process_claimed_job(job)
                    except Exception:  # noqa: BLE001 - final per-job containment boundary.
                        logger.exception("Unhandled background job boundary failure for %s", job.pk)

            try:
                metrics = worker_metrics()
                publish_worker_metrics(metrics)
                self.stdout.write(json.dumps(metrics, sort_keys=True))
            except Exception:  # noqa: BLE001 - observability must not terminate delivery.
                logger.exception("Background worker metrics cycle failed")

            if options["once"]:
                return
            if not processed_jobs:
                time.sleep(poll_seconds)
