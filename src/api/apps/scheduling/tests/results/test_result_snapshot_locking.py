from concurrent.futures import ThreadPoolExecutor
from threading import Event as ThreadEvent
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase

from apps.authn.tests.helpers import create_member
from apps.scheduling.models import Event, EventResultInvalidation, EventResultSnapshot
from apps.scheduling.services.result_snapshots import (
    recompute_event_results,
    request_event_results_recompute,
)


@skipUnless(connection.vendor == "postgresql", "PostgreSQL transaction visibility")
class EventResultSnapshotLockingTests(TransactionTestCase):
    def setUp(self):
        organizer = create_member("snapshot-locking@example.com")
        self.event = Event.objects.create(
            code="SNAPLOCK",
            name="Snapshot locking",
            organizer=organizer,
            mode="inperson",
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            slot_minutes=30,
            meeting_duration_minutes=30,
            days=[1],
        )

    def test_committed_invalidation_during_calculation_blocks_stale_publication(self):
        calculation_started = ThreadEvent()
        allow_completion = ThreadEvent()

        def blocked_calculation(_event, *, now=None):
            calculation_started.set()
            self.assertTrue(allow_completion.wait(timeout=5))
            return {"revision": "old"}

        def worker():
            try:
                return recompute_event_results(self.event.pk)
            finally:
                connections["default"].close()

        with (
            patch(
                "apps.scheduling.services.result_snapshots.build_event_results",
                side_effect=blocked_calculation,
            ),
            ThreadPoolExecutor(max_workers=1) as executor,
        ):
            future = executor.submit(worker)
            self.assertTrue(calculation_started.wait(timeout=5))
            invalidation = request_event_results_recompute(self.event.pk)
            allow_completion.set()
            result = future.result(timeout=5)

        self.assertEqual(
            result,
            {"attempted": True, "status": "refreshing", "published": False},
        )
        invalidation.refresh_from_db()
        self.assertIsNotNone(invalidation.processed_at)
        self.assertEqual(
            EventResultInvalidation.objects.filter(
                event=self.event,
                processed_at__isnull=True,
            ).count(),
            0,
        )
        self.event.refresh_from_db()
        self.assertEqual(self.event.results_revision, 2)
        snapshot = EventResultSnapshot.objects.get(event=self.event)
        self.assertEqual(snapshot.requested_revision, 2)
        self.assertEqual(snapshot.computed_revision, 0)
        self.assertEqual(snapshot.status, EventResultSnapshot.Status.REFRESHING)
