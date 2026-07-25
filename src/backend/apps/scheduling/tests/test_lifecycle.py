import json
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.scheduling.lifecycle import LifecycleError, response_write_error, transition_event
from apps.scheduling.models import Event, EventInvitation, Participant, Weight


class LifecycleDomainTests(TestCase):
    def setUp(self):
        self.organizer = create_member("lifecycle-domain@example.com")
        self.now = timezone.now()

    def event(self, *, code, status=Event.Status.OPEN, deadline=None):
        return Event.objects.create(
            code=code,
            name=code,
            organizer=self.organizer,
            status=status,
            response_deadline=deadline,
            opened_at=self.now if status == Event.Status.OPEN else None,
        )

    def test_response_write_rules(self):
        event = self.event(code="WRITEOK")
        self.assertIsNone(response_write_error(event, now=self.now))
        event.response_deadline = self.now + timedelta(minutes=1)
        self.assertIsNone(response_write_error(event, now=self.now))
        event.response_deadline = self.now
        self.assertEqual(
            response_write_error(event, now=self.now),
            "The response deadline has passed.",
        )
        event.status = Event.Status.CLOSED
        self.assertEqual(
            response_write_error(event, now=self.now),
            "Responses cannot change while the event is closed.",
        )

    def test_legal_transitions_timestamps_deadlines_and_errors(self):
        draft = self.event(code="DRAFT", status=Event.Status.DRAFT)
        future = self.now + timedelta(days=1)
        changed = transition_event(
            draft,
            Event.Status.OPEN,
            response_deadline=future,
            now=self.now,
        )
        self.assertEqual(draft.status, Event.Status.OPEN)
        self.assertEqual(draft.version, 2)
        self.assertEqual(draft.opened_at, self.now)
        self.assertIn("response_deadline", changed)

        self.assertEqual(
            transition_event(
                draft,
                Event.Status.OPEN,
                response_deadline=future,
                now=self.now,
            ),
            set(),
        )
        changed = transition_event(
            draft,
            Event.Status.OPEN,
            response_deadline=None,
            now=self.now,
        )
        self.assertEqual(changed, {"response_deadline", "updated_at", "version"})

        changed = transition_event(
            draft,
            Event.Status.CLOSED,
            response_deadline=None,
            now=self.now,
        )
        self.assertEqual(draft.closed_at, self.now)
        self.assertIn("closed_at", changed)

        draft.finalized_at = self.now
        draft.archived_at = self.now
        changed = transition_event(
            draft,
            Event.Status.OPEN,
            response_deadline=future,
            now=self.now + timedelta(minutes=1),
        )
        self.assertIsNone(draft.finalized_at)
        self.assertIsNone(draft.closed_at)
        self.assertIsNone(draft.archived_at)
        self.assertIn("opened_at", changed)

        changed = transition_event(
            draft,
            Event.Status.ARCHIVED,
            response_deadline=future,
            now=self.now,
        )
        self.assertEqual(draft.archived_at, self.now)
        self.assertIn("archived_at", changed)
        transition_event(
            draft,
            Event.Status.OPEN,
            response_deadline=future,
            now=self.now,
        )

        finalized = self.event(code="WASFINAL", status=Event.Status.FINALIZED)
        transition_event(
            finalized,
            Event.Status.CLOSED,
            response_deadline=None,
            now=self.now,
        )
        self.assertEqual(finalized.status, Event.Status.CLOSED)

        with self.assertRaisesMessage(LifecycleError, "Invalid event status"):
            transition_event(draft, "unknown", response_deadline=future, now=self.now)
        with self.assertRaisesMessage(LifecycleError, "Confirm a final meeting time"):
            transition_event(
                draft,
                Event.Status.FINALIZED,
                response_deadline=future,
                now=self.now,
            )
        with self.assertRaisesMessage(LifecycleError, "Cannot transition"):
            transition_event(
                draft,
                Event.Status.DRAFT,
                response_deadline=future,
                now=self.now,
            )
        closed = self.event(code="PASTOPEN", status=Event.Status.CLOSED)
        with self.assertRaisesMessage(LifecycleError, "future response deadline"):
            transition_event(
                closed,
                Event.Status.OPEN,
                response_deadline=self.now,
                now=self.now,
            )


class LifecycleApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("lifecycle-organizer@example.com", "Org", "Owner")
        self.participant = create_member("lifecycle-participant@example.com", "Pat", "Person")
        self.other = create_member("lifecycle-other@example.com", "Other", "Person")
        self.event = Event.objects.create(
            code="LIFECYCLE",
            name="Lifecycle",
            organizer=self.organizer,
            status=Event.Status.OPEN,
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            days=[1],
            opened_at=timezone.now(),
        )

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def join(self):
        self.authenticate(self.participant)
        response = self.client.post(
            f"/api/events/participants?code={self.event.code}",
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        return response.data["participant"]

    def transition(self, status, expected_version, *, deadline_marker=False, deadline=None):
        payload = {"status": status, "expectedVersion": expected_version}
        if deadline_marker:
            payload["responseDeadline"] = deadline
        return self.client.put(
            f"/api/events/lifecycle?code={self.event.code}",
            payload,
            format="json",
        )

    def test_event_creation_status_and_deadline_validation(self):
        self.authenticate(self.organizer)
        draft = self.client.post(
            "/api/events",
            {"name": "Draft", "status": "draft"},
            format="json",
        )
        self.assertEqual(draft.status_code, 201)
        self.assertEqual(draft.data["event"]["status"], "draft")
        self.assertIsNone(draft.data["event"]["openedAt"])

        open_event = self.client.post(
            "/api/events",
            {"name": "Open", "status": "open"},
            format="json",
        )
        self.assertEqual(open_event.status_code, 201)
        self.assertIsNotNone(open_event.data["event"]["openedAt"])
        naive_future = (timezone.now() + timedelta(days=1)).replace(tzinfo=None)
        naive_deadline = self.client.post(
            "/api/events",
            {"name": "Naive deadline", "responseDeadline": naive_future.isoformat()},
            format="json",
        )
        self.assertEqual(naive_deadline.status_code, 201)

        invalid = self.client.post(
            "/api/events",
            {"name": "Invalid", "status": "closed"},
            format="json",
        )
        self.assertEqual(invalid.status_code, 400)
        past = self.client.post(
            "/api/events",
            {
                "name": "Past",
                "responseDeadline": (timezone.now() - timedelta(minutes=1)).isoformat(),
            },
            format="json",
        )
        self.assertEqual(past.status_code, 400)

    def test_lifecycle_permissions_conflicts_idempotency_and_reopening(self):
        self.authenticate(self.other)
        self.assertEqual(
            self.client.put("/api/events/lifecycle", {}, format="json").status_code, 400
        )
        self.assertEqual(
            self.client.put(
                "/api/events/lifecycle?code=NOPE",
                {"status": "closed", "expectedVersion": 1},
                format="json",
            ).status_code,
            404,
        )
        self.assertEqual(
            self.transition(Event.Status.CLOSED, self.event.version).status_code,
            403,
        )

        self.authenticate(self.organizer)
        missing_version = self.client.put(
            f"/api/events/lifecycle?code={self.event.code}",
            {"status": "closed"},
            format="json",
        )
        self.assertEqual(missing_version.status_code, 428)
        bool_version = self.transition(Event.Status.CLOSED, True)
        self.assertEqual(bool_version.status_code, 428)
        invalid_deadline = self.transition(
            Event.Status.OPEN,
            self.event.version,
            deadline_marker=True,
            deadline="not-a-date",
        )
        self.assertEqual(invalid_deadline.status_code, 400)
        list_deadline = self.transition(
            Event.Status.OPEN,
            self.event.version,
            deadline_marker=True,
            deadline=[],
        )
        self.assertEqual(list_deadline.status_code, 400)

        closed = self.transition(Event.Status.CLOSED, self.event.version)
        self.assertEqual(closed.status_code, 200)
        self.assertEqual(closed.data["event"]["status"], "closed")
        closed_version = closed.data["event"]["version"]

        current_duplicate = self.transition(Event.Status.CLOSED, closed_version)
        self.assertEqual(current_duplicate.status_code, 200)
        self.assertEqual(current_duplicate.data["event"]["version"], closed_version)

        duplicate = self.transition(Event.Status.CLOSED, self.event.version)
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.data["event"]["version"], closed_version)

        stale = self.transition(Event.Status.ARCHIVED, self.event.version)
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.data["event"]["version"], closed_version)

        self.event.refresh_from_db()
        past = timezone.now() - timedelta(minutes=1)
        self.event.response_deadline = past
        self.event.save(update_fields=["response_deadline"])
        failed_reopen = self.transition(
            Event.Status.OPEN,
            self.event.version,
            deadline_marker=True,
            deadline=past.isoformat(),
        )
        self.assertEqual(failed_reopen.status_code, 400)

        future = timezone.now() + timedelta(days=1)
        reopened = self.transition(
            Event.Status.OPEN,
            self.event.version,
            deadline_marker=True,
            deadline=future.isoformat(),
        )
        self.assertEqual(reopened.status_code, 200)
        self.assertEqual(reopened.data["event"]["status"], "open")
        self.assertEqual(reopened.data["event"]["version"], self.event.version + 1)

        removed_deadline = self.transition(
            Event.Status.OPEN,
            reopened.data["event"]["version"],
            deadline_marker=True,
            deadline=None,
        )
        self.assertEqual(removed_deadline.status_code, 200)

        naive_extension = (future + timedelta(days=1)).replace(tzinfo=None)
        extended = self.transition(
            Event.Status.OPEN,
            removed_deadline.data["event"]["version"],
            deadline_marker=True,
            deadline=naive_extension.isoformat(),
        )
        self.assertEqual(extended.status_code, 200)
        self.assertGreater(
            extended.data["event"]["version"],
            reopened.data["event"]["version"],
        )

        invalid_status = self.transition("unknown", extended.data["event"]["version"])
        self.assertEqual(invalid_status.status_code, 400)
        finalization = self.transition(
            Event.Status.FINALIZED,
            extended.data["event"]["version"],
        )
        self.assertEqual(finalization.status_code, 400)

    def test_deadline_status_and_concurrent_response_writes(self):
        participant = self.join()
        base_url = (
            f"/api/events/participants/update?code={self.event.code}"
            f"&participantId={self.participant.pk}"
        )
        schedule_one = [1] * 2
        schedule_zero = [0] * 2

        no_version = self.client.put(
            base_url,
            {"availabilityInperson": schedule_one},
            format="json",
        )
        self.assertEqual(no_version.status_code, 428)
        bool_version = self.client.put(
            base_url,
            {"availabilityInperson": schedule_one, "expectedVersion": True},
            format="json",
        )
        self.assertEqual(bool_version.status_code, 428)
        bad_submitted = self.client.put(
            base_url,
            {"submitted": "yes", "expectedVersion": participant["version"]},
            format="json",
        )
        self.assertEqual(bad_submitted.status_code, 400)

        submitted = self.client.put(
            base_url,
            {
                "availabilityInperson": schedule_one,
                "submitted": 1,
                "expectedVersion": participant["version"],
            },
            format="json",
        )
        self.assertEqual(submitted.status_code, 200)
        current_version = submitted.data["participant"]["version"]
        self.assertEqual(current_version, participant["version"] + 1)

        unchanged = self.client.put(
            base_url,
            {
                "availabilityInperson": schedule_one,
                "submitted": True,
                "expectedVersion": current_version,
            },
            format="json",
        )
        self.assertEqual(unchanged.status_code, 200)
        self.assertEqual(unchanged.data["participant"]["version"], current_version)

        stringified = self.client.put(
            base_url,
            {
                "availabilityInperson": json.dumps(schedule_one),
                "submitted": True,
                "expectedVersion": participant["version"],
            },
            format="json",
        )
        self.assertEqual(stringified.status_code, 400)

        stale_identical = self.client.put(
            base_url,
            {
                "availabilityInperson": schedule_one,
                "submitted": True,
                "expectedVersion": participant["version"],
            },
            format="json",
        )
        self.assertEqual(stale_identical.status_code, 200)
        self.assertEqual(stale_identical.data["participant"]["version"], current_version)

        conflict = self.client.put(
            base_url,
            {
                "availabilityInperson": schedule_zero,
                "expectedVersion": participant["version"],
            },
            format="json",
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertIn("another session", conflict.data["error"])

        invitation = EventInvitation.objects.create(
            event=self.event,
            email=self.participant.email,
            member=self.participant,
            invited_by=self.organizer,
            status=EventInvitation.Status.SUBMITTED,
        )
        withdrawn = self.client.put(
            base_url,
            {
                "submitted": False,
                "expectedVersion": current_version,
            },
            format="json",
        )
        self.assertEqual(withdrawn.status_code, 200)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.DRAFT_SAVED)
        current_version = withdrawn.data["participant"]["version"]

        stored_participant = Participant.objects.get(event=self.event, member=self.participant)
        stored_participant.availability_inperson = "[bad"
        stored_participant.save(update_fields=["availability_inperson"])
        repaired = self.client.put(
            base_url,
            {
                "availabilityInperson": schedule_zero,
                "expectedVersion": current_version,
            },
            format="json",
        )
        self.assertEqual(repaired.status_code, 200)
        current_version = repaired.data["participant"]["version"]

        self.authenticate(self.other)
        unrelated_metadata = self.client.put(
            base_url,
            {"groupName": "Denied"},
            format="json",
        )
        self.assertEqual(unrelated_metadata.status_code, 403)

        self.authenticate(self.organizer)
        organizer_edit = self.client.put(
            base_url,
            {
                "availabilityInperson": schedule_zero,
                "expectedVersion": current_version,
            },
            format="json",
        )
        self.assertEqual(organizer_edit.status_code, 403)
        invalid_sort = self.client.put(
            base_url,
            {"sortOrder": "bad"},
            format="json",
        )
        self.assertEqual(invalid_sort.status_code, 400)

        self.authenticate(self.participant)
        weight = Weight.objects.create(
            event=self.event,
            participant=Participant.objects.get(event=self.event, member=self.participant),
            included=False,
        )
        excluded = self.client.put(
            base_url,
            {
                "availabilityInperson": schedule_zero,
                "expectedVersion": current_version,
            },
            format="json",
        )
        self.assertEqual(excluded.status_code, 403)
        weight.included = True
        weight.save(update_fields=["included"])

        for status in [
            Event.Status.FINALIZED,
            Event.Status.CLOSED,
            Event.Status.ARCHIVED,
        ]:
            self.event.status = status
            self.event.save(update_fields=["status"])
            locked = self.client.put(
                base_url,
                {
                    "availabilityInperson": schedule_zero,
                    "expectedVersion": current_version,
                },
                format="json",
            )
            self.assertEqual(locked.status_code, 409)

        self.event.status = Event.Status.OPEN
        self.event.response_deadline = timezone.now() - timedelta(seconds=1)
        self.event.save(update_fields=["status", "response_deadline"])
        expired = self.client.put(
            base_url,
            {
                "availabilityInperson": schedule_zero,
                "expectedVersion": current_version,
            },
            format="json",
        )
        self.assertEqual(expired.status_code, 409)

        late_member = create_member("late-lifecycle@example.com")
        self.authenticate(late_member)
        late_join = self.client.post(
            f"/api/events/participants?code={self.event.code}",
            {},
            format="json",
        )
        self.assertEqual(late_join.status_code, 409)

    def test_response_analytics_timestamps_are_first_occurrence_and_idempotent(self):
        participant_payload = self.join()
        base_url = (
            f"/api/events/participants/update?code={self.event.code}"
            f"&participantId={self.participant.pk}"
        )

        unchanged_draft = self.client.put(
            base_url,
            {
                "submitted": False,
                "expectedVersion": participant_payload["version"],
            },
            format="json",
        )
        self.assertEqual(unchanged_draft.status_code, 200)
        participant = Participant.objects.get(event=self.event, member=self.participant)
        self.assertIsNotNone(participant.first_draft_saved_at)

        Participant.objects.filter(pk=participant.pk).update(
            submitted=True,
            first_submitted_at=None,
            last_submitted_at=None,
        )
        participant.refresh_from_db()
        unchanged_submission = self.client.put(
            base_url,
            {
                "submitted": True,
                "expectedVersion": participant.version,
            },
            format="json",
        )
        self.assertEqual(unchanged_submission.status_code, 200)
        participant.refresh_from_db()
        first_submitted_at = participant.first_submitted_at
        last_submitted_at = participant.last_submitted_at
        self.assertIsNotNone(first_submitted_at)
        self.assertEqual(first_submitted_at, last_submitted_at)

        changed_submission = self.client.put(
            base_url,
            {
                "availabilityInperson": [1, 1],
                "expectedVersion": participant.version,
            },
            format="json",
        )
        self.assertEqual(changed_submission.status_code, 200)
        participant.refresh_from_db()
        self.assertEqual(participant.first_submitted_at, first_submitted_at)
        self.assertGreaterEqual(participant.last_submitted_at, last_submitted_at)
