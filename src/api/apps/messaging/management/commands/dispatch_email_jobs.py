from __future__ import annotations

import signal
from threading import Event as StopEvent

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.messaging.services import dispatch_due_email_jobs


class Command(BaseCommand):
    help = "Dispatch due durable email delivery jobs."

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.stop_event = StopEvent()

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=settings.EMAIL_WORKER_BATCH_SIZE)
        parser.add_argument("--concurrency", type=int, default=settings.EMAIL_WORKER_CONCURRENCY)
        parser.add_argument(
            "--rate-limit",
            type=float,
            default=settings.EMAIL_WORKER_RATE_PER_SECOND,
        )
        parser.add_argument("--watch", action="store_true")
        parser.add_argument(
            "--poll-interval",
            type=float,
            default=settings.EMAIL_WORKER_POLL_SECONDS,
        )

    def _request_stop(self, _signum, _frame):
        self.stop_event.set()

    def _write_summary(self, summary):
        self.stdout.write(
            "Email jobs: "
            f"attempted={summary['attempted']} "
            f"sent={summary['sent']} "
            f"retry={summary['retry']} "
            f"permanent_failure={summary['permanentFailure']} "
            f"canceled={summary['canceled']}."
        )

    def handle(self, *args, **options):
        limit = options["limit"]
        concurrency = options["concurrency"]
        rate_limit = options["rate_limit"]
        poll_interval = options["poll_interval"]
        watch = options["watch"]
        if limit < 1 or limit > 1000:
            raise CommandError("limit must be between 1 and 1000")
        if concurrency < 1 or concurrency > 64:
            raise CommandError("concurrency must be between 1 and 64")
        if rate_limit < 0 or rate_limit > 1000:
            raise CommandError("rate-limit must be between 0 and 1000 per second")
        if poll_interval < 0.1 or poll_interval > 300:
            raise CommandError("poll-interval must be between 0.1 and 300 seconds")

        previous_handlers = {}
        if watch:
            for signum in (signal.SIGINT, signal.SIGTERM):
                previous_handlers[signum] = signal.getsignal(signum)
                signal.signal(signum, self._request_stop)
        try:
            while not self.stop_event.is_set():
                summary = dispatch_due_email_jobs(
                    limit=limit,
                    concurrency=concurrency,
                    rate_limit_per_second=rate_limit or None,
                    stop_event=self.stop_event,
                )
                self._write_summary(summary)
                if not watch:
                    break
                self.stop_event.wait(poll_interval)
        finally:
            for signum, handler in previous_handlers.items():
                signal.signal(signum, handler)
