from __future__ import annotations

import signal
from threading import Event as StopEvent

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.scheduling.models import Event
from apps.scheduling.services.results import (
    recompute_due_event_results,
    recompute_event_results,
)


class Command(BaseCommand):
    help = "Compute and publish versioned event result snapshots."

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.stop_event = StopEvent()

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=settings.RESULT_WORKER_BATCH_SIZE)
        parser.add_argument("--event-code")
        parser.add_argument("--watch", action="store_true")
        parser.add_argument(
            "--poll-interval",
            type=float,
            default=settings.RESULT_WORKER_POLL_SECONDS,
        )
        parser.add_argument("--no-retry-failed", action="store_true")

    def _request_stop(self, _signum, _frame):
        self.stop_event.set()

    def _write_summary(self, summary):
        self.stdout.write(
            "Event results: "
            f"attempted={summary['attempted']} "
            f"published={summary['published']} "
            f"failed={summary['failed']} "
            f"skipped={summary['skipped']}."
        )

    def handle(self, *args, **options):
        limit = options["limit"]
        poll_interval = options["poll_interval"]
        event_code = str(options.get("event_code") or "").strip().upper()
        watch = options["watch"]
        if limit < 1 or limit > 1000:
            raise CommandError("limit must be between 1 and 1000")
        if poll_interval < 0.1 or poll_interval > 300:
            raise CommandError("poll-interval must be between 0.1 and 300 seconds")
        if event_code and watch:
            raise CommandError("event-code cannot be combined with watch")

        if event_code:
            event_id = Event.objects.filter(code=event_code).values_list("pk", flat=True).first()
            if event_id is None:
                raise CommandError("event not found")
            result = recompute_event_results(event_id, force=True)
            self._write_summary(
                {
                    "attempted": int(result["attempted"]),
                    "published": int(result["published"]),
                    "failed": int(result["status"] == "failed"),
                    "skipped": int(not result["published"] and result["status"] != "failed"),
                }
            )
            return

        previous_handlers = {}
        if watch:
            for signum in (signal.SIGINT, signal.SIGTERM):
                previous_handlers[signum] = signal.getsignal(signum)
                signal.signal(signum, self._request_stop)
        try:
            while not self.stop_event.is_set():
                summary = recompute_due_event_results(
                    limit=limit,
                    retry_failed=not options["no_retry_failed"],
                )
                self._write_summary(summary)
                if not watch:
                    break
                self.stop_event.wait(poll_interval)
        finally:
            for signum, handler in previous_handlers.items():
                signal.signal(signum, handler)
