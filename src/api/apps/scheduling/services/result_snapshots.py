from __future__ import annotations

import uuid
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Case, F, IntegerField, Q, Value, When
from django.utils import timezone

from apps.scheduling.models import Event, EventResultInvalidation, EventResultSnapshot
from apps.scheduling.services.aggregation import build_event_results

RESULT_LOCK_TIMEOUT = timedelta(seconds=settings.RESULT_SNAPSHOT_LOCK_TIMEOUT_SECONDS)
RESULT_FAILURE_RETRY_DELAY = timedelta(seconds=settings.RESULT_FAILURE_RETRY_DELAY_SECONDS)


def _snapshot_defaults(event: Event) -> dict:
    return {
        "requested_revision": event.results_revision,
        "computed_revision": 0,
        "status": "refreshing",
        "payload": {},
    }


def ensure_result_snapshot(event: Event) -> EventResultSnapshot:
    """Return an event snapshot and reconcile it with the event's current revision."""

    with transaction.atomic():
        snapshot, _created = EventResultSnapshot.objects.select_for_update().get_or_create(
            event=event,
            defaults=_snapshot_defaults(event),
        )
        if snapshot.requested_revision < event.results_revision:
            snapshot.requested_revision = event.results_revision
            snapshot.status = "refreshing"
            snapshot.last_error = ""
            snapshot.save(
                update_fields=[
                    "requested_revision",
                    "status",
                    "last_error",
                    "updated_at",
                ]
            )
        return snapshot


def mark_event_results_dirty(event_or_id) -> int:
    """Atomically advance an event revision and request one coalesced recomputation."""

    event_id = getattr(event_or_id, "pk", event_or_id)
    with transaction.atomic():
        event = Event.objects.select_for_update().get(pk=event_id)
        Event.objects.filter(pk=event.pk).update(results_revision=F("results_revision") + 1)
        event.refresh_from_db(fields=["results_revision"])
        snapshot, _created = EventResultSnapshot.objects.select_for_update().get_or_create(
            event=event,
            defaults=_snapshot_defaults(event),
        )
        snapshot.requested_revision = event.results_revision
        snapshot.status = "refreshing"
        snapshot.last_error = ""
        snapshot.save(
            update_fields=[
                "requested_revision",
                "status",
                "last_error",
                "updated_at",
            ]
        )
    if isinstance(event_or_id, Event):
        event_or_id.results_revision = event.results_revision
    return event.results_revision


def _flush_locked_event_invalidations(
    event: Event,
) -> tuple[int, EventResultSnapshot | None]:
    """Consume pending invalidations while the caller holds the Event row lock."""

    pending_ids = list(
        EventResultInvalidation.objects.select_for_update()
        .filter(event=event, processed_at__isnull=True)
        .order_by("created_at")
        .values_list("pk", flat=True)
    )
    if not pending_ids:
        return event.results_revision, None

    Event.objects.filter(pk=event.pk).update(
        results_revision=F("results_revision") + len(pending_ids)
    )
    event.results_revision += len(pending_ids)
    revision = event.results_revision
    snapshot, _created = EventResultSnapshot.objects.select_for_update().get_or_create(
        event=event,
        defaults=_snapshot_defaults(event),
    )
    snapshot.requested_revision = revision
    snapshot.status = EventResultSnapshot.Status.REFRESHING
    snapshot.last_error = ""
    snapshot.save(
        update_fields=[
            "requested_revision",
            "status",
            "last_error",
            "updated_at",
        ]
    )
    processed_at = timezone.now()
    EventResultInvalidation.objects.filter(pk__in=pending_ids).update(
        processed_at=processed_at,
        updated_at=processed_at,
    )
    return revision, snapshot


def flush_event_result_invalidations(event_or_id) -> int | None:
    """Coalesce durable response-write signals into one short revision transaction."""

    event_id = getattr(event_or_id, "pk", event_or_id)
    with transaction.atomic():
        event = Event.objects.select_for_update().filter(pk=event_id).first()
        if event is None:
            return None
        revision, _snapshot = _flush_locked_event_invalidations(event)
    if isinstance(event_or_id, Event):
        event_or_id.results_revision = revision
    return revision


def request_event_results_recompute(event_or_id) -> EventResultInvalidation:
    """Persist a result invalidation without locking the shared Event row."""

    event_id = getattr(event_or_id, "pk", event_or_id)
    return EventResultInvalidation.objects.create(event_id=event_id)


def serialize_result_snapshot(event: Event) -> dict:
    flush_event_result_invalidations(event)
    snapshot = ensure_result_snapshot(event)
    return {
        "status": snapshot.status,
        "requestedRevision": snapshot.requested_revision,
        "computedRevision": snapshot.computed_revision,
        "generatedAt": (
            snapshot.completed_at.isoformat() if snapshot.completed_at is not None else None
        ),
        "lastError": snapshot.last_error if snapshot.status == "failed" else "",
        "results": snapshot.payload or None,
    }


def _claim_result_snapshot(event_id, *, now, force: bool):
    stale_before = now - RESULT_LOCK_TIMEOUT
    with transaction.atomic():
        event = Event.objects.select_for_update().filter(pk=event_id).first()
        if event is None:
            return None, None, None
        snapshot, _created = EventResultSnapshot.objects.select_for_update().get_or_create(
            event=event,
            defaults=_snapshot_defaults(event),
        )
        has_active_lock = (
            snapshot.lock_token is not None
            and snapshot.locked_at is not None
            and snapshot.locked_at > stale_before
        )
        if has_active_lock:
            return event, snapshot, None
        if not force and snapshot.computed_revision >= event.results_revision:
            if snapshot.status != "fresh" or snapshot.requested_revision != event.results_revision:
                snapshot.status = "fresh"
                snapshot.requested_revision = event.results_revision
                snapshot.last_error = ""
                snapshot.locked_at = None
                snapshot.lock_token = None
                snapshot.save(
                    update_fields=[
                        "status",
                        "requested_revision",
                        "last_error",
                        "locked_at",
                        "lock_token",
                        "updated_at",
                    ]
                )
            return event, snapshot, None

        token = uuid.uuid4()
        snapshot.requested_revision = event.results_revision
        snapshot.status = "refreshing"
        snapshot.started_at = now
        snapshot.last_error = ""
        snapshot.locked_at = now
        snapshot.lock_token = token
        snapshot.save(
            update_fields=[
                "requested_revision",
                "status",
                "started_at",
                "last_error",
                "locked_at",
                "lock_token",
                "updated_at",
            ]
        )
        return event, snapshot, token


def recompute_event_results(event_id, *, now=None, force: bool = False) -> dict:
    """Compute and publish one revision, discarding output if a newer revision wins."""

    flush_event_result_invalidations(event_id)
    current_time = now or timezone.now()
    event, snapshot, token = _claim_result_snapshot(
        event_id,
        now=current_time,
        force=force,
    )
    if event is None:
        return {"attempted": False, "status": "missing", "published": False}
    if token is None:
        return {
            "attempted": False,
            "status": snapshot.status,
            "published": False,
        }
    target_revision = snapshot.requested_revision

    try:
        payload = build_event_results(event, now=current_time)
    except Exception as exc:  # noqa: BLE001
        with transaction.atomic():
            latest_event = Event.objects.select_for_update().filter(pk=event.pk).first()
            if latest_event is None:
                return {"attempted": True, "status": "missing", "published": False}
            _latest_revision, invalidated_snapshot = _flush_locked_event_invalidations(latest_event)
            claimed = invalidated_snapshot or (
                EventResultSnapshot.objects.select_for_update().filter(pk=snapshot.pk).first()
            )
            if claimed is None:
                return {"attempted": True, "status": "missing", "published": False}
            if claimed.lock_token != token:
                return {
                    "attempted": True,
                    "status": claimed.status,
                    "published": False,
                }
            latest_revision = latest_event.results_revision
            claimed.requested_revision = latest_revision
            claimed.status = "failed" if latest_revision == target_revision else "refreshing"
            claimed.last_error = str(exc)[:4000]
            claimed.locked_at = None
            claimed.lock_token = None
            claimed.save(
                update_fields=[
                    "requested_revision",
                    "status",
                    "last_error",
                    "locked_at",
                    "lock_token",
                    "updated_at",
                ]
            )
        return {
            "attempted": True,
            "status": claimed.status,
            "published": False,
            "error": claimed.last_error,
        }

    completed_at = timezone.now() if now is None else current_time
    with transaction.atomic():
        latest_event = Event.objects.select_for_update().filter(pk=event.pk).first()
        if latest_event is None:
            return {"attempted": True, "status": "missing", "published": False}
        _latest_revision, invalidated_snapshot = _flush_locked_event_invalidations(latest_event)
        claimed = invalidated_snapshot or (
            EventResultSnapshot.objects.select_for_update().filter(pk=snapshot.pk).first()
        )
        if claimed is None:
            return {"attempted": True, "status": "missing", "published": False}
        if claimed.lock_token != token:
            return {
                "attempted": True,
                "status": claimed.status,
                "published": False,
            }
        if latest_event.results_revision != target_revision:
            claimed.requested_revision = latest_event.results_revision
            claimed.status = "refreshing"
            claimed.locked_at = None
            claimed.lock_token = None
            claimed.save(
                update_fields=[
                    "requested_revision",
                    "status",
                    "locked_at",
                    "lock_token",
                    "updated_at",
                ]
            )
            return {"attempted": True, "status": "refreshing", "published": False}

        claimed.payload = payload
        claimed.requested_revision = target_revision
        claimed.computed_revision = target_revision
        claimed.status = "fresh"
        claimed.completed_at = completed_at
        claimed.last_error = ""
        claimed.locked_at = None
        claimed.lock_token = None
        claimed.save(
            update_fields=[
                "payload",
                "requested_revision",
                "computed_revision",
                "status",
                "completed_at",
                "last_error",
                "locked_at",
                "lock_token",
                "updated_at",
            ]
        )
    return {"attempted": True, "status": "fresh", "published": True}


def recompute_due_event_results(
    *,
    limit: int = 100,
    now=None,
    retry_failed: bool = True,
) -> dict:
    current_time = now or timezone.now()
    stale_before = current_time - RESULT_LOCK_TIMEOUT
    pending_event_ids = list(
        EventResultInvalidation.objects.filter(processed_at__isnull=True)
        .order_by()
        .values_list("event_id", flat=True)
        .distinct()[:limit]
    )
    for pending_event_id in pending_event_ids:
        flush_event_result_invalidations(pending_event_id)
    due = Event.objects.filter(
        Q(result_snapshot__isnull=True)
        | Q(result_snapshot__computed_revision__lt=F("results_revision"))
        | (
            Q(result_snapshot__status=EventResultSnapshot.Status.REFRESHING)
            & (
                Q(result_snapshot__locked_at__isnull=True)
                | Q(result_snapshot__locked_at__lte=stale_before)
            )
        )
    )
    if not retry_failed:
        due = due.exclude(result_snapshot__status="failed")
    else:
        retry_before = current_time - RESULT_FAILURE_RETRY_DELAY
        due = due.exclude(
            result_snapshot__status="failed",
            result_snapshot__started_at__gt=retry_before,
        )
    failure_priority = Case(
        When(result_snapshot__status="failed", then=Value(1)),
        default=Value(0),
        output_field=IntegerField(),
    )
    event_ids = list(
        due.order_by(failure_priority, "updated_at").values_list("pk", flat=True)[:limit]
    )
    summary = {
        "attempted": 0,
        "published": 0,
        "failed": 0,
        "skipped": 0,
    }
    for event_id in event_ids:
        result = recompute_event_results(event_id, now=current_time)
        if not result["attempted"]:
            summary["skipped"] += 1
            continue
        summary["attempted"] += 1
        if result["published"]:
            summary["published"] += 1
        elif result["status"] == "failed":
            summary["failed"] += 1
        else:
            summary["skipped"] += 1
    return summary
