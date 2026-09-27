"""The roster ids an import commit reports, so invitations can be reviewed before they go out."""

import uuid

from django.test import TestCase
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob
from apps.scheduling.models import Event, Participant, RosterImportBatch, UserEvent
from apps.scheduling.services.invitations import create_or_reuse_managed_participant


class RosterImportParticipantIdsTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("ids-owner@example.com", "Event", "Owner")
        self.event = Event.objects.create(
            code="IMPIDS01",
            name="Import ids",
            organizer=self.organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        UserEvent.objects.create(member=self.organizer, event=self.event, role="organizer")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(self.organizer)}")

    def add_person(self, name, email):
        return create_or_reuse_managed_participant(
            event=self.event, organizer=self.organizer, name=name, email=email
        )["participant"]

    def paste(self, content):
        response = self.client.post(
            f"/events/roster-imports?code={self.event.code}",
            {"sourceType": "paste", "pastedText": content},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        return response.data["import"]["id"]

    def commit(self, import_id, *, key=None, **extra):
        return self.client.post(
            f"/events/roster-imports/{import_id}/commit?code={self.event.code}",
            {"mode": "merge", "idempotencyKey": str(key or uuid.uuid4()), **extra},
            format="json",
        )

    def roster_id(self, email):
        return str(Participant.objects.get(event=self.event, member__email=email).pk)

    def test_merge_reports_who_it_added_and_who_it_touched(self):
        self.add_person("Known", "known@example.com")
        hidden = self.add_person("Hidden", "hidden@example.com")
        Participant.objects.filter(pk=hidden.pk).update(hidden=True)
        import_id = self.paste(
            "name,email\n"
            "New Person,new@example.com\n"
            "Known,known@example.com\n"
            "Hidden Again,hidden@example.com\n"
            "Kim No Email,\n"
        )
        key = uuid.uuid4()

        committed = self.commit(import_id, key=key, sendInvitations=False)

        self.assertEqual(committed.status_code, 201, committed.data)
        new, known, restored = (
            self.roster_id(email)
            for email in ("new@example.com", "known@example.com", "hidden@example.com")
        )
        # Kim is someone the organizer manages: never emailed, so never listed.
        self.assertTrue(
            Participant.objects.filter(event=self.event, organizer_managed=True).exists()
        )
        self.assertEqual(committed.data["addedParticipantIds"], [new, restored])
        self.assertEqual(committed.data["importedParticipantIds"], [new, known, restored])
        self.assertFalse(EmailDeliveryJob.objects.exists())

        # The ids are the roster rows' own ids.
        roster = self.client.get(f"/events/roster?code={self.event.code}")
        roster_ids = {row["id"] for row in roster.data["participants"]}
        self.assertLessEqual(set(committed.data["importedParticipantIds"]), roster_ids)

        replay = self.commit(import_id, key=key, sendInvitations=False)
        self.assertEqual(replay.status_code, 200, replay.data)
        self.assertTrue(replay.data["idempotent"])
        self.assertEqual(replay.data["addedParticipantIds"], [new, restored])
        self.assertEqual(replay.data["importedParticipantIds"], [new, known, restored])

    def test_rebuild_lists_everyone_it_imported(self):
        self.add_person("Old", "old@example.com")
        import_id = self.paste("name,email\nFirst,first@example.com\nSecond,second@example.com\n")

        rebuilt = self.commit(
            import_id, mode="rebuild", confirmationCode=self.event.code, sendInvitations=False
        )

        self.assertEqual(rebuilt.status_code, 201, rebuilt.data)
        expected = [self.roster_id("first@example.com"), self.roster_id("second@example.com")]
        self.assertEqual(rebuilt.data["importedParticipantIds"], expected)
        self.assertEqual(rebuilt.data["addedParticipantIds"], expected)

    def test_sending_invitations_on_commit_still_reports_ids(self):
        import_id = self.paste("name,email\nFresh,fresh@example.com\n")
        committed = self.commit(import_id)
        self.assertEqual(committed.status_code, 201, committed.data)
        self.assertEqual(committed.data["autoInvitedCount"], 1)
        self.assertEqual(
            committed.data["addedParticipantIds"], [self.roster_id("fresh@example.com")]
        )

    def test_a_commit_recorded_without_ids_replays_with_none(self):
        import_id = self.paste("name,email\nFresh,fresh@example.com\n")
        key = uuid.uuid4()
        self.assertEqual(self.commit(import_id, key=key).status_code, 201)
        RosterImportBatch.objects.filter(pk=import_id).update(
            summary={"imported": 1, "created": 1, "updated": 0}
        )
        replay = self.commit(import_id, key=key)
        self.assertEqual(replay.status_code, 200, replay.data)
        self.assertEqual(replay.data["addedParticipantIds"], [])
        self.assertEqual(replay.data["importedParticipantIds"], [])
