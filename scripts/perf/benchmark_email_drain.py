#!/usr/bin/env python3
"""Enqueue and drain 1,000 invitation jobs against a guarded local test database."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "src" / "backend"
sys.path.insert(0, str(BACKEND_ROOT))

EXPECTED_RECIPIENTS = 1_000
LOCAL_DATABASE_HOSTS = {"", "localhost", "127.0.0.1", "::1"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure a simulated provider handoff for 1,000 durable invitation jobs."
    )
    parser.add_argument("--settings", default="config.settings.test_postgres")
    parser.add_argument("--event-code", required=True)
    parser.add_argument("--confirm-code", required=True)
    parser.add_argument("--concurrency", type=int, default=10)
    parser.add_argument("--rate-limit", type=float, default=10.0)
    parser.add_argument("--assert-seconds", type=float, default=900.0)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    args.event_code = args.event_code.strip().upper()
    if args.confirm_code.strip().upper() != args.event_code:
        parser.error("--confirm-code must exactly match --event-code")
    if args.concurrency < 1 or args.concurrency > 100:
        parser.error("--concurrency must be between 1 and 100")
    if args.rate_limit <= 0 or args.rate_limit > 10_000:
        parser.error("--rate-limit must be between 0 and 10,000")
    if args.assert_seconds <= 0 or args.assert_seconds > 3_600:
        parser.error("--assert-seconds must be between 0 and 3,600")
    return args


def configure_django(settings_module: str) -> None:
    os.environ["DJANGO_SETTINGS_MODULE"] = settings_module
    import django

    django.setup()


def assert_safe_runtime() -> dict:
    from django.conf import settings
    from django.db import connection

    connection.ensure_connection()
    details = connection.settings_dict
    host = str(details.get("HOST") or "").strip().lower()
    database_name = str(details.get("NAME") or "")
    if connection.vendor != "postgresql":
        raise RuntimeError("this benchmark requires PostgreSQL")
    if host not in LOCAL_DATABASE_HOSTS:
        raise RuntimeError(f"refusing non-loopback PostgreSQL host {host!r}")
    if not any(marker in database_name.lower() for marker in ("test", "perf")):
        raise RuntimeError(
            f"refusing database {database_name!r}; its name must contain 'test' or 'perf'"
        )
    if getattr(settings, "USE_SES_EMAIL_PROVIDER", False):
        raise RuntimeError("refusing to run while the SES provider is enabled")
    backend = str(getattr(settings, "EMAIL_BACKEND", ""))
    safe_backends = (
        "django.core.mail.backends.locmem.EmailBackend",
        "django.core.mail.backends.filebased.EmailBackend",
        "django.core.mail.backends.console.EmailBackend",
    )
    if backend not in safe_backends:
        raise RuntimeError(f"refusing non-simulator email backend {backend!r}")
    return {
        "database": database_name,
        "host": host or "local-socket",
        "emailBackend": backend,
    }


def run(args: argparse.Namespace) -> dict:
    from apps.authn.models import ContactEmail
    from apps.messaging.models import EmailDeliveryJob
    from apps.messaging.services import dispatch_due_email_jobs, email_delivery_summary
    from apps.scheduling.models import Event
    from apps.scheduling.services.invitations import upsert_and_send_invitations

    event = Event.objects.select_related("organizer").filter(code=args.event_code).first()
    if event is None:
        raise RuntimeError(f"event {args.event_code!r} does not exist")
    member_ids = list(
        event.participants.filter(hidden=False)
        .order_by("sort_order", "created_at")
        .values_list("member_id", flat=True)
    )
    emails = list(
        ContactEmail.objects.filter(member_id__in=member_ids, email_type="primary")
        .order_by("email_address")
        .values_list("email_address", flat=True)
    )
    if len(member_ids) != EXPECTED_RECIPIENTS or len(set(emails)) != EXPECTED_RECIPIENTS:
        raise RuntimeError(
            f"fixture must have exactly {EXPECTED_RECIPIENTS} active participants and "
            "unique primary emails"
        )

    request_key = uuid.uuid4()
    enqueue_started = time.perf_counter()
    queued = upsert_and_send_invitations(
        event=event,
        emails=emails,
        invited_by=event.organizer,
        idempotency_key=request_key,
        message="Local 1,000-recipient provider-handoff benchmark.",
    )
    enqueue_seconds = time.perf_counter() - enqueue_started
    request_record = queued["request"]
    if request_record.jobs.count() != EXPECTED_RECIPIENTS:
        raise RuntimeError("the delivery request did not contain exactly 1,000 jobs")

    drain_started = time.perf_counter()
    dispatch_summary = dispatch_due_email_jobs(
        limit=EXPECTED_RECIPIENTS,
        concurrency=args.concurrency,
        rate_limit_per_second=args.rate_limit,
    )
    drain_seconds = time.perf_counter() - drain_started
    terminal = email_delivery_summary(request_record.jobs.only("status"))
    passed = (
        terminal["total"] == EXPECTED_RECIPIENTS
        and terminal["sent"] == EXPECTED_RECIPIENTS
        and terminal["permanentFailure"] == 0
        and drain_seconds <= args.assert_seconds
    )
    return {
        "eventCode": event.code,
        "deliveryRequestId": str(request_record.pk),
        "idempotencyKey": str(request_key),
        "enqueueSeconds": round(enqueue_seconds, 3),
        "providerHandoffSeconds": round(drain_seconds, 3),
        "concurrency": args.concurrency,
        "rateLimitPerSecond": args.rate_limit,
        "thresholdSeconds": args.assert_seconds,
        "dispatch": dispatch_summary,
        "terminal": terminal,
        "passed": passed,
    }


def main() -> int:
    args = parse_args()
    configure_django(args.settings)
    runtime = assert_safe_runtime()
    result = {"runtime": runtime, **run(args)}
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(
            f"Email drain: sent={result['terminal']['sent']}/1000 "
            f"seconds={result['providerHandoffSeconds']:.3f} "
            f"threshold={result['thresholdSeconds']:.3f}"
        )
        print("PASS" if result["passed"] else "FAIL")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
