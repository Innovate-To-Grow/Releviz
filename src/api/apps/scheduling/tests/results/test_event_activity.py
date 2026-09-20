from datetime import timedelta

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.scheduling.models import Event, EventInvitation, Participant, Weight
from apps.scheduling.services.activity import event_activity, roster_activity
from apps.scheduling.services.results import (
    recompute_event_results,
    request_event_results_recompute,
    serialize_result_snapshot,
)


class EventActivityDigestTests(TestCase):
    def setUp(self):
        self.organizer = create_member("activity-organizer@example.com")
        self.member = create_member("activity-member@example.com")
        self.event = Event.objects.create(
            code="ACTIVITY",
            name="Activity",
            organizer=self.organizer,
            mode="inperson",
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            slot_minutes=30,
            meeting_duration_minutes=30,
            days=[1],
        )

    def test_empty_roster_has_no_change_timestamp(self):
        self.assertEqual(
            roster_activity(self.event),
            {"total": 0, "submitted": 0, "changedAt": None},
        )

    def test_roster_digest_follows_people_invitations_and_weights(self):
        participant = Participant.objects.create(
            event=self.event,
            member=self.member,
            participant_name="Member",
        )
        first = roster_activity(self.event)
        self.assertEqual(first["total"], 1)
        self.assertEqual(first["submitted"], 0)
        self.assertEqual(first["changedAt"], participant.updated_at.isoformat())

        later = timezone.now() + timedelta(minutes=1)
        invitation = EventInvitation.objects.create(
            event=self.event,
            email="activity-member@example.com",
            member=self.member,
        )
        EventInvitation.objects.filter(pk=invitation.pk).update(updated_at=later)
        self.assertEqual(roster_activity(self.event)["changedAt"], later.isoformat())

        # A weight edit is the newest write even when the person and the
        # invitation are older.
        weight = Weight.objects.create(event=self.event, participant=participant, weight=0.5)
        latest = later + timedelta(minutes=1)
        Weight.objects.filter(pk=weight.pk).update(updated_at=latest)
        self.assertEqual(roster_activity(self.event)["changedAt"], latest.isoformat())

        # Submitting moves the count, and the participant's own timestamp wins
        # once it is the newest write.
        newest = latest + timedelta(minutes=1)
        Participant.objects.filter(pk=participant.pk).update(submitted=True, updated_at=newest)
        submitted = roster_activity(self.event)
        self.assertEqual(submitted["submitted"], 1)
        self.assertEqual(submitted["changedAt"], newest.isoformat())

    def test_event_digest_folds_pending_invalidations_like_the_results_read(self):
        recompute_event_results(self.event.pk)
        fresh = event_activity(self.event)
        self.assertEqual(
            fresh["event"],
            {"version": 1, "status": "active", "resultsRevision": 1},
        )
        self.assertEqual(fresh["results"]["status"], "fresh")
        self.assertEqual(fresh["results"]["computedRevision"], 1)
        self.assertEqual(fresh["results"]["requestedRevision"], 1)
        self.assertIsNotNone(fresh["results"]["generatedAt"])
        self.assertEqual(fresh["roster"], {"total": 0, "submitted": 0, "changedAt": None})

        request_event_results_recompute(self.event)
        pending = event_activity(self.event)
        self.assertEqual(pending["event"]["resultsRevision"], 2)
        self.assertEqual(pending["results"]["status"], "refreshing")
        self.assertEqual(pending["results"]["requestedRevision"], 2)
        self.assertEqual(pending["results"]["computedRevision"], 1)
        # The digest and the full results read describe the same snapshot.
        results = serialize_result_snapshot(self.event)
        self.assertEqual(
            pending["results"],
            {
                key: results[key]
                for key in ("status", "requestedRevision", "computedRevision", "generatedAt")
            },
        )


class EventActivityApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("activity-api-organizer@example.com")
        self.participant = create_member("activity-api-participant@example.com")
        self.event = Event.objects.create(
            code="ACTIVITYAPI",
            name="Activity API",
            organizer=self.organizer,
            mode="inperson",
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            slot_minutes=30,
            meeting_duration_minutes=30,
            days=[1],
            access_mode="open_link",
        )

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def test_only_the_organizer_reads_the_digest(self):
        self.assertEqual(self.client.get("/events/activity?code=ACTIVITYAPI").status_code, 401)

        self.authenticate(self.participant)
        self.client.post("/events/participants?code=ACTIVITYAPI", {}, format="json")
        forbidden = self.client.get("/events/activity?code=ACTIVITYAPI")
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(
            forbidden.data["error"],
            "You do not have permission to view event activity",
        )

        self.authenticate(self.organizer)
        self.assertEqual(self.client.get("/events/activity").status_code, 400)
        self.assertEqual(self.client.get("/events/activity?code=NOPE").status_code, 404)

    def test_digest_moves_with_a_new_response_and_matches_the_roster_listing(self):
        self.authenticate(self.organizer)
        before = self.client.get("/events/activity?code=ACTIVITYAPI")
        self.assertEqual(before.status_code, 200)
        self.assertIn("no-store", before["Cache-Control"])
        self.assertEqual(before.data["roster"], {"total": 0, "submitted": 0, "changedAt": None})
        self.assertEqual(before.data["results"]["status"], "refreshing")
        revision = before.data["event"]["resultsRevision"]

        self.authenticate(self.participant)
        joined = self.client.post("/events/participants?code=ACTIVITYAPI", {}, format="json")
        self.assertEqual(joined.status_code, 201)
        submitted = self.client.put(
            f"/events/participants/update?code=ACTIVITYAPI&participantId={self.participant.pk}",
            {
                "availabilityInperson": [1, 1],
                "submitted": 1,
                "expectedVersion": joined.data["participant"]["version"],
            },
            format="json",
        )
        self.assertEqual(submitted.status_code, 200)

        self.authenticate(self.organizer)
        after = self.client.get("/events/activity?code=ACTIVITYAPI")
        self.assertEqual(after.status_code, 200)
        self.assertGreater(after.data["event"]["resultsRevision"], revision)
        self.assertEqual(after.data["results"]["status"], "refreshing")
        self.assertEqual(after.data["roster"]["total"], 1)
        self.assertEqual(after.data["roster"]["submitted"], 1)
        self.assertIsNotNone(after.data["roster"]["changedAt"])

        roster = self.client.get("/events/roster?code=ACTIVITYAPI")
        self.assertEqual(roster.status_code, 200)
        self.assertEqual(roster.data["activity"], after.data["roster"])

        # Once the worker publishes, the digest reports the fresh snapshot
        # the results endpoint serves.
        recompute_event_results(self.event.pk)
        published = self.client.get("/events/activity?code=ACTIVITYAPI")
        results = self.client.get("/events/results?code=ACTIVITYAPI")
        self.assertEqual(published.data["results"]["status"], "fresh")
        self.assertEqual(
            published.data["results"]["computedRevision"],
            results.data["computedRevision"],
        )
        self.assertEqual(published.data["results"]["generatedAt"], results.data["generatedAt"])
