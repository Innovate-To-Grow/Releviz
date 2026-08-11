import uuid
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core.management import CommandError, call_command
from django.test import TestCase
from django.utils import timezone

from apps.authn.tests.helpers import create_member
from apps.scheduling.models import Event, EventResultInvalidation, EventResultSnapshot
from apps.scheduling.result_snapshots import (
    ensure_result_snapshot,
    flush_event_result_invalidations,
    mark_event_results_dirty,
    recompute_due_event_results,
    recompute_event_results,
    request_event_results_recompute,
    serialize_result_snapshot,
)


class EventResultSnapshotTests(TestCase):
    def setUp(self):
        organizer = create_member("snapshot-organizer@example.com")
        self.event = Event.objects.create(
            code="SNAPSHOT",
            name="Snapshot",
            organizer=organizer,
            mode="inperson",
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            slot_minutes=30,
            meeting_duration_minutes=30,
            days=[1],
        )

    def test_snapshot_lifecycle_dirty_coalescing_and_serialization(self):
        initial = serialize_result_snapshot(self.event)
        self.assertEqual(
            initial,
            {
                "status": "refreshing",
                "requestedRevision": 1,
                "computedRevision": 0,
                "generatedAt": None,
                "lastError": "",
                "results": None,
            },
        )

        first = recompute_event_results(self.event.pk)
        self.assertEqual(first, {"attempted": True, "status": "fresh", "published": True})
        fresh = serialize_result_snapshot(self.event)
        self.assertEqual(fresh["status"], "fresh")
        self.assertEqual(fresh["computedRevision"], 1)
        self.assertEqual(fresh["results"]["eventCode"], self.event.code)
        self.assertIsNotNone(fresh["generatedAt"])

        self.assertEqual(mark_event_results_dirty(self.event), 2)
        self.assertEqual(mark_event_results_dirty(self.event.pk), 3)
        self.assertEqual(self.event.results_revision, 2)
        self.event.refresh_from_db()
        self.assertEqual(self.event.results_revision, 3)
        refreshing = serialize_result_snapshot(self.event)
        self.assertEqual(refreshing["requestedRevision"], 3)
        self.assertEqual(refreshing["computedRevision"], 1)
        self.assertEqual(refreshing["results"]["eventCode"], self.event.code)

        summary = recompute_due_event_results(limit=10)
        self.assertEqual(summary["attempted"], 1)
        self.assertEqual(summary["published"], 1)
        self.assertEqual(recompute_due_event_results(limit=10)["attempted"], 0)
        self.assertEqual(
            recompute_event_results(self.event.pk),
            {"attempted": False, "status": "fresh", "published": False},
        )

    def test_newer_revision_prevents_stale_publish_and_failure_can_recover(self):
        def make_stale(_event, *, now=None):
            request_event_results_recompute(self.event.pk)
            return {"stale": True}

        with patch(
            "apps.scheduling.result_snapshots.build_event_results",
            side_effect=make_stale,
        ):
            stale = recompute_event_results(self.event.pk)
        self.assertEqual(stale, {"attempted": True, "status": "refreshing", "published": False})
        snapshot = EventResultSnapshot.objects.get(event=self.event)
        self.assertEqual(snapshot.computed_revision, 0)
        self.assertEqual(snapshot.requested_revision, 2)

        with patch(
            "apps.scheduling.result_snapshots.build_event_results",
            side_effect=RuntimeError("calculation failed"),
        ):
            failed = recompute_event_results(self.event.pk)
        self.assertEqual(failed["status"], "failed")
        self.assertIn("calculation failed", failed["error"])
        self.event.refresh_from_db()
        failed_payload = serialize_result_snapshot(self.event)
        self.assertEqual(failed_payload["lastError"], "calculation failed")

        skipped = recompute_due_event_results(limit=10, retry_failed=False)
        self.assertEqual(skipped["attempted"], 0)
        self.assertEqual(recompute_due_event_results(limit=10)["attempted"], 0)
        snapshot.refresh_from_db()
        recovered = recompute_due_event_results(
            limit=10,
            now=snapshot.started_at + timedelta(seconds=31),
        )
        self.assertEqual(recovered["published"], 1)

    def test_durable_invalidations_coalesce_into_one_revision_transaction(self):
        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            first = request_event_results_recompute(self.event)
            second = request_event_results_recompute(self.event.pk)
        self.assertEqual(callbacks, [])
        self.event.refresh_from_db()
        self.assertEqual(self.event.results_revision, 1)
        self.assertEqual(
            EventResultInvalidation.objects.filter(
                event=self.event,
                processed_at__isnull=True,
            ).count(),
            2,
        )

        revision = flush_event_result_invalidations(self.event)
        self.assertEqual(revision, 3)
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertIsNotNone(first.processed_at)
        self.assertIsNotNone(second.processed_at)
        snapshot = EventResultSnapshot.objects.get(event=self.event)
        self.assertEqual(snapshot.requested_revision, 3)
        self.assertEqual(snapshot.status, EventResultSnapshot.Status.REFRESHING)
        self.assertEqual(flush_event_result_invalidations(self.event.pk), 3)
        self.assertIsNone(flush_event_result_invalidations(999999))

        third = request_event_results_recompute(self.event)
        summary = recompute_due_event_results(limit=10)
        self.assertEqual(summary["published"], 1)
        third.refresh_from_db()
        self.assertIsNotNone(third.processed_at)
        self.event.refresh_from_db()
        self.assertEqual(self.event.results_revision, 4)

    def test_due_worker_recovers_a_stale_forced_refresh_lock_at_current_revision(self):
        self.assertTrue(recompute_event_results(self.event.pk)["published"])
        snapshot = EventResultSnapshot.objects.get(event=self.event)
        now = timezone.now()
        snapshot.status = EventResultSnapshot.Status.REFRESHING
        snapshot.locked_at = now - timedelta(seconds=59)
        snapshot.lock_token = uuid.uuid4()
        snapshot.save(update_fields=["status", "locked_at", "lock_token", "updated_at"])

        active = recompute_due_event_results(limit=10, now=now)
        self.assertEqual(active["attempted"], 0)
        snapshot.locked_at = now - timedelta(seconds=61)
        snapshot.save(update_fields=["locked_at", "updated_at"])
        recovered = recompute_due_event_results(limit=10, now=now)
        self.assertEqual(recovered["skipped"], 1)
        snapshot.refresh_from_db()
        self.assertEqual(snapshot.status, EventResultSnapshot.Status.FRESH)
        self.assertIsNone(snapshot.locked_at)
        self.assertIsNone(snapshot.lock_token)

    def test_lock_recovery_and_changed_lock_token_protect_the_winner(self):
        snapshot = ensure_result_snapshot(self.event)
        snapshot.lock_token = uuid.uuid4()
        snapshot.locked_at = timezone.now()
        snapshot.save(update_fields=["lock_token", "locked_at", "updated_at"])
        self.assertEqual(
            recompute_event_results(self.event.pk),
            {"attempted": False, "status": "refreshing", "published": False},
        )

        snapshot.locked_at = timezone.now() - timedelta(seconds=61)
        snapshot.save(update_fields=["locked_at", "updated_at"])
        recovered = recompute_event_results(self.event.pk)
        self.assertTrue(recovered["published"])

        mark_event_results_dirty(self.event.pk)

        def replace_lock(_event, *, now=None):
            EventResultSnapshot.objects.filter(event=self.event).update(lock_token=uuid.uuid4())
            return {"winner": "other worker"}

        with patch(
            "apps.scheduling.result_snapshots.build_event_results",
            side_effect=replace_lock,
        ):
            lost = recompute_event_results(self.event.pk)
        self.assertEqual(lost["attempted"], True)
        self.assertFalse(lost["published"])

    def test_reconciliation_failure_races_and_missing_event_cleanup(self):
        snapshot = ensure_result_snapshot(self.event)
        Event.objects.filter(pk=self.event.pk).update(results_revision=2)
        self.event.refresh_from_db()
        reconciled = ensure_result_snapshot(self.event)
        self.assertEqual(reconciled.requested_revision, 2)

        reconciled.computed_revision = 2
        reconciled.requested_revision = 1
        reconciled.status = "failed"
        reconciled.last_error = "old failure"
        reconciled.save(
            update_fields=[
                "computed_revision",
                "requested_revision",
                "status",
                "last_error",
                "updated_at",
            ]
        )
        corrected = recompute_event_results(self.event.pk)
        self.assertEqual(corrected["status"], "fresh")
        reconciled.refresh_from_db()
        self.assertEqual(reconciled.requested_revision, 2)
        self.assertEqual(reconciled.last_error, "")

        mark_event_results_dirty(self.event.pk)

        def replace_lock_and_fail(_event, *, now=None):
            EventResultSnapshot.objects.filter(event=self.event).update(lock_token=uuid.uuid4())
            raise RuntimeError("losing worker")

        with patch(
            "apps.scheduling.result_snapshots.build_event_results",
            side_effect=replace_lock_and_fail,
        ):
            lost = recompute_event_results(self.event.pk)
        self.assertFalse(lost["published"])
        snapshot = EventResultSnapshot.objects.get(event=self.event)
        snapshot.locked_at = None
        snapshot.lock_token = None
        snapshot.save(update_fields=["locked_at", "lock_token", "updated_at"])

        def newer_revision_and_fail(_event, *, now=None):
            request_event_results_recompute(self.event.pk)
            raise RuntimeError("stale failure")

        with patch(
            "apps.scheduling.result_snapshots.build_event_results",
            side_effect=newer_revision_and_fail,
        ):
            stale_failure = recompute_event_results(self.event.pk)
        self.assertEqual(stale_failure["status"], "refreshing")
        self.assertIn("stale failure", stale_failure["error"])

        def delete_during_calculation(_event, *, now=None):
            Event.objects.filter(pk=self.event.pk).delete()
            return {"deleted": True}

        with patch(
            "apps.scheduling.result_snapshots.build_event_results",
            side_effect=delete_during_calculation,
        ):
            missing = recompute_event_results(self.event.pk)
        self.assertEqual(missing["status"], "missing")

    def test_due_summary_reports_locked_failed_and_stale_work(self):
        snapshot = ensure_result_snapshot(self.event)
        snapshot.locked_at = timezone.now()
        snapshot.lock_token = uuid.uuid4()
        snapshot.save(update_fields=["locked_at", "lock_token", "updated_at"])
        locked = recompute_due_event_results(limit=10)
        self.assertEqual(locked["skipped"], 1)

        snapshot.locked_at = None
        snapshot.lock_token = None
        snapshot.save(update_fields=["locked_at", "lock_token", "updated_at"])
        with patch(
            "apps.scheduling.result_snapshots.build_event_results",
            side_effect=RuntimeError("due failure"),
        ):
            failed = recompute_due_event_results(limit=10)
        self.assertEqual(failed["failed"], 1)
        snapshot.refresh_from_db()
        retry_time = snapshot.started_at + timedelta(seconds=31)

        def supersede(_event, *, now=None):
            request_event_results_recompute(self.event.pk)
            return {"old": True}

        with patch(
            "apps.scheduling.result_snapshots.build_event_results",
            side_effect=supersede,
        ):
            stale = recompute_due_event_results(limit=10, now=retry_time)
        self.assertEqual(stale["skipped"], 1)

    def test_deleted_event_during_failed_calculation_is_reported_missing(self):
        def delete_and_fail(_event, *, now=None):
            Event.objects.filter(pk=self.event.pk).delete()
            raise RuntimeError("event removed")

        with patch(
            "apps.scheduling.result_snapshots.build_event_results",
            side_effect=delete_and_fail,
        ):
            result = recompute_event_results(self.event.pk)
        self.assertEqual(result, {"attempted": True, "status": "missing", "published": False})

    def test_deleted_snapshot_during_success_or_failure_is_reported_missing(self):
        def delete_snapshot(_event, *, now=None):
            EventResultSnapshot.objects.filter(event=self.event).delete()
            return {"deleted": True}

        with patch(
            "apps.scheduling.result_snapshots.build_event_results",
            side_effect=delete_snapshot,
        ):
            succeeded_without_snapshot = recompute_event_results(self.event.pk)
        self.assertEqual(
            succeeded_without_snapshot,
            {"attempted": True, "status": "missing", "published": False},
        )

        def delete_snapshot_and_fail(_event, *, now=None):
            EventResultSnapshot.objects.filter(event=self.event).delete()
            raise RuntimeError("snapshot removed")

        with patch(
            "apps.scheduling.result_snapshots.build_event_results",
            side_effect=delete_snapshot_and_fail,
        ):
            failed_without_snapshot = recompute_event_results(self.event.pk)
        self.assertEqual(
            failed_without_snapshot,
            {"attempted": True, "status": "missing", "published": False},
        )

    def test_missing_event_and_command_validation(self):
        self.assertEqual(
            recompute_event_results(999999),
            {"attempted": False, "status": "missing", "published": False},
        )
        output = StringIO()
        call_command("recompute_event_results", "--event-code=SNAPSHOT", stdout=output)
        self.assertIn("attempted=1 published=1", output.getvalue())
        for arguments, message in [
            (("--limit=0",), "limit"),
            (("--poll-interval=0",), "poll-interval"),
            (("--event-code=missing",), "event not found"),
            (("--event-code=SNAPSHOT", "--watch"), "cannot be combined"),
        ]:
            with self.subTest(arguments=arguments), self.assertRaisesMessage(CommandError, message):
                call_command("recompute_event_results", *arguments)
