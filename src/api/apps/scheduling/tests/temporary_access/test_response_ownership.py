"""Who may enter a participant's response: the organizer until the person claims it."""

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.core.cache import cache
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail
from apps.authn.tests.helpers import create_member, token_for
from apps.core.utils.logging import JsonFormatter
from apps.scheduling.models import (
    Event,
    EventInvitation,
    FinalMeeting,
    Participant,
    ScheduleEditRecord,
    Weight,
)
from apps.scheduling.permissions import organizer_may_edit_response
from apps.scheduling.services.invitations import mark_invitation_for_member

OWNED_CODE = "organizer_edit_participant_owned"
OWNED_MESSAGE = (
    "This participant now manages their own response, so the organizer can no longer change it."
)


def client_for(member):
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")
    return client


class ResponseOwnershipTests(TestCase):
    def setUp(self):
        self.organizer = create_member("owner@example.com", "Event", "Owner")
        self.full_member = create_member("full@example.com", "Full", "Member")
        self.organizer_client = client_for(self.organizer)
        self.full_client = client_for(self.full_member)
        self.event = self.create_event("OWNED001")

    def create_event(self, code, **fields):
        return Event.objects.create(
            code=code,
            name="Ownership planning",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            access_mode="open_link",
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            **fields,
        )

    def add_only(self, email="full@example.com", *, event=None, name="Organizer label"):
        return self.organizer_client.post(
            f"/events/participants/managed?code={(event or self.event).code}",
            {
                "name": name,
                "email": email,
                "idempotencyKey": str(uuid.uuid4()),
                "sendInvitation": False,
            },
            format="json",
        )

    def fresh_full_account(self, label):
        member = create_member(f"{label}@example.com", label.title(), "Person")
        added = self.add_only(f"{label}@example.com", name=label.title())
        self.assertEqual(added.status_code, 201, added.data)
        self.assertTrue(added.data["participant"]["canOrganizerEditAvailability"])
        return member

    def put(self, client, member, body, *, event=None):
        return client.put(
            (
                f"/events/participants/update?code={(event or self.event).code}"
                f"&participantId={member.pk}"
            ),
            body,
            format="json",
        )

    def row(self, member, *, event=None):
        return Participant.objects.get(event=event or self.event, member=member)

    def version(self, member, *, event=None):
        return self.row(member, event=event).version

    def roster_row(self, member, *, event=None, query=""):
        response = self.organizer_client.get(
            f"/events/roster?code={(event or self.event).code}{query}"
        )
        self.assertEqual(response.status_code, 200, response.data)
        rows = [
            item for item in response.data["participants"] if item["memberId"] == str(member.pk)
        ]
        return rows[0] if rows else None

    def organizer_write(self, member, availability=(0, 1), *, submitted=0, event=None):
        return self.put(
            self.organizer_client,
            member,
            {
                "name": "Organizer label",
                "availabilityInperson": list(availability),
                "submitted": submitted,
                "expectedVersion": self.version(member, event=event),
            },
            event=event,
        )

    def assert_owned_denial(self, response):
        self.assertEqual(response.status_code, 403, response.data)
        self.assertEqual(response.data["errorCode"], OWNED_CODE)
        self.assertEqual(response.data["error"], OWNED_MESSAGE)
        self.assertIs(response.data["participant"]["canOrganizerEditAvailability"], False)
        self.assertIn("no-store", response["Cache-Control"])

    def test_predicate_arms(self):
        now = timezone.now()
        temporary = create_member(
            "pred-temp@example.com", access_level="temporary", contact_verified=False
        )
        managed = create_member("pred-managed@example.com")
        claimed = create_member("pred-claimed@example.com")

        def participant(member, **fields):
            return Participant.objects.create(
                event=self.event,
                member=member,
                participant_name=member.display_name(),
                availability_inperson=[0, 0],
                availability_virtual=[0, 0],
                **fields,
            )

        self.assertFalse(organizer_may_edit_response(participant(self.organizer)))
        self.assertTrue(
            organizer_may_edit_response(
                participant(managed, organizer_managed=True, response_claimed_at=now)
            )
        )
        self.assertTrue(
            organizer_may_edit_response(participant(temporary, response_claimed_at=now))
        )
        self.assertTrue(organizer_may_edit_response(participant(self.full_member)))
        self.assertFalse(organizer_may_edit_response(participant(claimed, response_claimed_at=now)))

    def test_add_only_existing_full_account_is_editable_until_the_person_responds(self):
        added = self.add_only()
        self.assertEqual(added.status_code, 201, added.data)
        self.assertEqual(added.data["participant"]["accountAccess"], "full")
        self.assertTrue(added.data["participant"]["canOrganizerEditAvailability"])
        self.assertTrue(self.roster_row(self.full_member)["canOrganizerEditAvailability"])
        row = self.row(self.full_member)
        schedule = self.organizer_client.get(
            f"/events/roster/{row.pk}/schedule?code={self.event.code}"
        )
        self.assertEqual(schedule.status_code, 200, schedule.data)
        self.assertTrue(schedule.data["participant"]["canOrganizerEditAvailability"])

        draft = self.organizer_write(self.full_member)
        self.assertEqual(draft.status_code, 200, draft.data)
        submitted = self.organizer_write(self.full_member, submitted=1)
        self.assertEqual(submitted.status_code, 200, submitted.data)
        self.assertEqual(submitted.data["participant"]["submitted"], 1)
        self.assertEqual(submitted.data["participant"]["invitationStatus"], "not_sent")
        self.assertTrue(submitted.data["participant"]["canOrganizerEditAvailability"])

        invitation = EventInvitation.objects.get(event=self.event, member=self.full_member)
        self.assertEqual(invitation.status, EventInvitation.Status.SUBMITTED)
        self.assertIsNone(invitation.accepted_at)
        self.assertIsNone(invitation.joined_at)
        self.assertIsNone(invitation.first_sent_at)
        self.assertEqual(
            set(row.schedule_edit_records.values_list("source", flat=True)),
            {ScheduleEditRecord.Source.ORGANIZER},
        )
        row.refresh_from_db()
        self.assertIsNone(row.response_claimed_at)

        own = self.put(
            self.full_client,
            self.full_member,
            {
                "availabilityInperson": [1, 0],
                "submitted": 1,
                "expectedVersion": self.version(self.full_member),
            },
        )
        self.assertEqual(own.status_code, 200, own.data)
        row.refresh_from_db()
        self.assertIsNotNone(row.response_claimed_at)
        invitation.refresh_from_db()
        self.assertIsNotNone(invitation.accepted_at)
        self.assertTrue(
            row.schedule_edit_records.filter(source=ScheduleEditRecord.Source.SELF).exists()
        )

        self.assert_owned_denial(self.organizer_write(self.full_member, (1, 1)))
        renamed = self.put(
            self.organizer_client,
            self.full_member,
            {"name": "Another label", "expectedVersion": self.version(self.full_member)},
        )
        self.assert_owned_denial(renamed)
        row.refresh_from_db()
        self.assertEqual(row.availability_inperson, [1, 0])
        self.assertFalse(self.roster_row(self.full_member)["canOrganizerEditAvailability"])

    def test_self_claim_persists_on_conflict_and_values_match(self):
        with self.subTest("stale version, different values"):
            member = self.fresh_full_account("stale-diff")
            stale = self.version(member)
            self.assertEqual(self.organizer_write(member).status_code, 200)
            conflict = self.put(
                client_for(member),
                member,
                {"availabilityInperson": [1, 0], "submitted": 0, "expectedVersion": stale},
            )
            self.assertEqual(conflict.status_code, 409, conflict.data)
            self.assertEqual(conflict.data["errorCode"], "participant_version_conflict")
            self.assertIsNotNone(self.row(member).response_claimed_at)
            self.assertIsNotNone(
                EventInvitation.objects.get(event=self.event, member=member).accepted_at
            )
            self.assert_owned_denial(self.organizer_write(member, (1, 1)))

        with self.subTest("stale version, identical values"):
            member = self.fresh_full_account("stale-same")
            stale = self.version(member)
            self.assertEqual(self.organizer_write(member).status_code, 200)
            same = self.put(
                client_for(member),
                member,
                {"availabilityInperson": [0, 1], "submitted": 0, "expectedVersion": stale},
            )
            self.assertEqual(same.status_code, 200, same.data)
            self.assertIsNotNone(self.row(member).response_claimed_at)

        with self.subTest("current version, identical values"):
            member = self.fresh_full_account("current-same")
            row = self.row(member)
            same = self.put(
                client_for(member),
                member,
                {
                    "availabilityInperson": row.availability_inperson,
                    "submitted": 0,
                    "expectedVersion": row.version,
                },
            )
            self.assertEqual(same.status_code, 200, same.data)
            claimed = self.row(member)
            self.assertIsNotNone(claimed.response_claimed_at)
            # Claiming is not an edit: the response version stays put.
            self.assertEqual(claimed.version, row.version)

    def test_rejected_self_writes_do_not_claim(self):
        def pass_deadline(member):
            Event.objects.filter(pk=self.event.pk).update(
                response_deadline=timezone.now() - timedelta(minutes=1)
            )

        def reopen_deadline(member):
            Event.objects.filter(pk=self.event.pk).update(response_deadline=None)

        def exclude(member):
            Weight.objects.create(event=self.event, participant=self.row(member), included=False)

        def include(member):
            Weight.objects.filter(participant=self.row(member)).delete()

        def noop(member):
            return None

        cases = [
            ("428", {"availabilityInperson": [1, 0]}, noop, noop, 428),
            ("deadline", {"availabilityInperson": [1, 0]}, pass_deadline, reopen_deadline, 409),
            ("excluded", {"availabilityInperson": [1, 0]}, exclude, include, 403),
            ("invalid", {"availabilityInperson": [7, 0]}, noop, noop, 400),
            ("rename", {"name": "Self label"}, noop, noop, 403),
            ("empty", {}, noop, noop, 200),
        ]
        for index, (label, body, before, after, status) in enumerate(cases):
            with self.subTest(label):
                member = self.fresh_full_account(f"rejected-{index}")
                before(member)
                if label not in {"428", "empty"}:
                    body = {**body, "expectedVersion": self.version(member)}
                response = self.put(client_for(member), member, body)
                self.assertEqual(response.status_code, status, response.data)
                after(member)
                self.assertIsNone(self.row(member).response_claimed_at)
                self.assertEqual(self.organizer_write(member).status_code, 200)

    def test_join_claims_new_and_existing_rows(self):
        self.assertEqual(self.add_only().status_code, 201)
        joined = self.full_client.post(f"/events/participants?code={self.event.code}", {})
        self.assertEqual(joined.status_code, 200, joined.data)
        self.assertNotIn("canOrganizerEditAvailability", joined.data["participant"])
        claimed_at = self.row(self.full_member).response_claimed_at
        self.assertIsNotNone(claimed_at)
        self.assert_owned_denial(self.organizer_write(self.full_member))

        other = self.create_event("OWNED002")
        self_joined = self.full_client.post(f"/events/participants?code={other.code}", {})
        self.assertEqual(self_joined.status_code, 201, self_joined.data)
        self.assertIsNotNone(self.row(self.full_member, event=other).response_claimed_at)

        again = self.full_client.post(f"/events/participants?code={self.event.code}", {})
        self.assertEqual(again.status_code, 200, again.data)
        self.assertEqual(self.row(self.full_member).response_claimed_at, claimed_at)

    def test_organizer_fills_unclaimed_full_account_after_deadline(self):
        self.assertEqual(self.add_only().status_code, 201)
        Event.objects.filter(pk=self.event.pk).update(
            response_deadline=timezone.now() - timedelta(minutes=1)
        )
        filled = self.organizer_write(self.full_member)
        self.assertEqual(filled.status_code, 200, filled.data)

        Event.objects.filter(pk=self.event.pk).update(status=Event.Status.CLOSED)
        closed = self.organizer_write(self.full_member, (1, 1))
        self.assertEqual(closed.status_code, 409, closed.data)
        self.assertEqual(closed.data["errorCode"], "participant_response_locked")

        Event.objects.filter(pk=self.event.pk).update(status=Event.Status.ACTIVE)
        now = timezone.now()
        FinalMeeting.objects.create(
            event=self.event,
            starts_at=now + timedelta(days=1),
            ends_at=now + timedelta(days=1, hours=1),
            timezone=self.event.timezone,
            channel="inperson",
            location=self.event.location,
            calendar_uid=f"{uuid.uuid4()}@releviz.local",
            confirmed_by=self.organizer,
            confirmed_at=now,
        )
        confirmed = self.organizer_write(self.full_member, (1, 1))
        self.assertEqual(confirmed.status_code, 409, confirmed.data)
        self.assertEqual(confirmed.data["errorCode"], "participant_response_locked")
        self.assertIsNone(self.row(self.full_member).response_claimed_at)

    def test_guard_claims_rows_with_self_evidence(self):
        def self_record(member):
            row = self.row(member)
            ScheduleEditRecord.objects.create(
                event=self.event,
                participant=row,
                actor=member,
                actor_identifier=member.pk,
                source=ScheduleEditRecord.Source.SELF,
                action=ScheduleEditRecord.Action.DRAFT,
                participant_version=row.version,
            )

        def accepted(member):
            EventInvitation.objects.filter(event=self.event, member=member).update(
                accepted_at=timezone.now()
            )

        def email_only(member):
            invitation = EventInvitation.objects.get(event=self.event, member=member)
            invitation.delete()
            EventInvitation.objects.create(
                event=self.event, email=invitation.email, member=None, invited_by=self.organizer
            )

        cases = [("self record", self_record), ("accepted", accepted), ("email", email_only)]
        for index, (label, evidence) in enumerate(cases):
            with self.subTest(label):
                member = self.fresh_full_account(f"guard-{index}")
                evidence(member)
                version = self.version(member)
                with patch("apps.scheduling.views.participants.update.security_logger") as log:
                    denied = self.organizer_write(member)
                self.assert_owned_denial(denied)
                self.assertEqual(
                    log.warning.call_args.kwargs["extra"]["denial_reason"],
                    "participant_owns_response",
                )
                self.assertEqual(log.warning.call_args.kwargs["extra"]["account_access"], "full")
                stamped = self.row(member)
                self.assertIsNotNone(stamped.response_claimed_at)
                self.assertEqual(stamped.version, version)
                self.assertFalse(self.roster_row(member)["canOrganizerEditAvailability"])

        with self.subTest("organizer records only"):
            member = self.fresh_full_account("guard-organizer")
            self.assertEqual(self.organizer_write(member).status_code, 200)
            with patch("apps.scheduling.views.participants.update.security_logger") as log:
                again = self.organizer_write(member, (1, 1))
            self.assertEqual(again.status_code, 200, again.data)
            log.warning.assert_not_called()
            self.assertEqual(log.info.call_args.args[0], "organizer_participant_response_updated")
            self.assertEqual(log.info.call_args.kwargs["extra"]["account_access"], "full")
            self.assertIsNone(self.row(member).response_claimed_at)

    def test_audit_log_lines_keep_the_account_class(self):
        # Production logs keep only allow-listed fields, and the account class is
        # what tells an organizer write to a full account from a temporary co-edit.
        member = self.fresh_full_account("audit")
        with self.assertLogs("releviz.security", level="INFO") as captured:
            self.assertEqual(self.organizer_write(member).status_code, 200)
            own = self.put(
                client_for(member),
                member,
                {"availabilityInperson": [1, 0], "expectedVersion": self.version(member)},
            )
            self.assertEqual(own.status_code, 200, own.data)
            self.assert_owned_denial(self.organizer_write(member, (1, 1)))
        lines = {
            line["event"]: line
            for line in (json.loads(JsonFormatter().format(record)) for record in captured.records)
        }
        self.assertEqual(lines["organizer_participant_response_updated"]["account_access"], "full")
        denied = lines["organizer_participant_edit_denied"]
        self.assertEqual(denied["account_access"], "full")
        self.assertEqual(denied["denial_reason"], "participant_owns_response")

    def test_organizer_own_row_is_never_organizer_editable(self):
        preview = self.organizer_client.post(
            f"/events/roster-imports?code={self.event.code}",
            {"sourceType": "paste", "pastedText": "name,email\nOwner Row,owner@example.com\n"},
            format="json",
        )
        self.assertEqual(preview.status_code, 201, preview.data)
        committed = self.organizer_client.post(
            f"/events/roster-imports/{preview.data['import']['id']}/commit?code={self.event.code}",
            {"mode": "merge", "idempotencyKey": str(uuid.uuid4())},
            format="json",
        )
        self.assertEqual(committed.status_code, 201, committed.data)
        own = self.row(self.organizer)
        self.assertIsNone(own.response_claimed_at)
        self.assertFalse(self.roster_row(self.organizer)["canOrganizerEditAvailability"])

        Event.objects.filter(pk=self.event.pk).update(
            response_deadline=timezone.now() - timedelta(minutes=1)
        )

        def own_write():
            # The drawer never opens on the organizer's own row, so no name is sent.
            return self.put(
                self.organizer_client,
                self.organizer,
                {
                    "availabilityInperson": [0, 1],
                    "submitted": 0,
                    "expectedVersion": self.version(self.organizer),
                },
            )

        with patch("apps.scheduling.views.participants.update.security_logger") as log:
            late = own_write()
        self.assertEqual(late.status_code, 409, late.data)
        self.assertEqual(late.data["errorCode"], "participant_response_locked")
        log.warning.assert_not_called()

        Event.objects.filter(pk=self.event.pk).update(response_deadline=None)
        saved = own_write()
        self.assertEqual(saved.status_code, 200, saved.data)
        own.refresh_from_db()
        self.assertIsNotNone(own.response_claimed_at)
        self.assertEqual(own.schedule_edit_records.get().source, ScheduleEditRecord.Source.SELF)

    def test_mark_invitation_accept_flag(self):
        invitation = EventInvitation.objects.create(
            event=self.event, email="full@example.com", member=None, invited_by=self.organizer
        )
        mark_invitation_for_member(
            event=self.event, member=self.full_member, submitted=True, accept=False
        )
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.SUBMITTED)
        self.assertIsNotNone(invitation.submitted_at)
        self.assertEqual(invitation.member_id, self.full_member.pk)
        self.assertIsNone(invitation.accepted_at)
        self.assertIsNone(invitation.joined_at)

        mark_invitation_for_member(event=self.event, member=self.full_member)
        invitation.refresh_from_db()
        self.assertIsNotNone(invitation.accepted_at)
        self.assertIsNotNone(invitation.joined_at)
        self.assertEqual(invitation.status, EventInvitation.Status.SUBMITTED)

    def test_badge_is_accepted_only_by_accepted_at(self):
        self.assertEqual(self.add_only().status_code, 201)
        invitations = EventInvitation.objects.filter(event=self.event, member=self.full_member)
        invitations.update(first_sent_at=timezone.now(), status=EventInvitation.Status.SUBMITTED)

        def listed_status():
            response = self.organizer_client.get(f"/events/participants?code={self.event.code}")
            self.assertEqual(response.status_code, 200, response.data)
            return response.data["participants"][0]["invitationStatus"]

        def drawer_status():
            row = self.row(self.full_member)
            response = self.organizer_client.put(
                (
                    f"/events/participants/update?code={self.event.code}"
                    f"&participantId={self.full_member.pk}"
                ),
                {},
                format="json",
            )
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(response.data["participant"]["version"], row.version)
            return response.data["participant"]["invitationStatus"]

        self.assertEqual(self.roster_row(self.full_member)["invitationStatus"], "sent")
        self.assertEqual(listed_status(), "sent")
        self.assertEqual(drawer_status(), "sent")
        self.assertIsNone(self.roster_row(self.full_member, query="&invitationStatus=accepted"))
        self.assertIsNone(self.roster_row(self.full_member, query="&invitationStatus=submitted"))

        invitations.update(accepted_at=timezone.now())
        self.assertEqual(self.roster_row(self.full_member)["invitationStatus"], "accepted")
        self.assertEqual(listed_status(), "accepted")
        self.assertEqual(drawer_status(), "accepted")
        self.assertIsNotNone(self.roster_row(self.full_member, query="&invitationStatus=accepted"))

    def test_hidden_and_restored_row_keeps_claim(self):
        self.assertEqual(self.add_only().status_code, 201)
        self.assertEqual(
            self.full_client.post(f"/events/participants?code={self.event.code}", {}).status_code,
            200,
        )
        hidden = self.organizer_client.delete(
            f"/events/participants/update?code={self.event.code}"
            f"&participantId={self.full_member.pk}"
        )
        self.assertEqual(hidden.status_code, 200, hidden.data)
        restored = self.add_only()
        self.assertEqual(restored.status_code, 200, restored.data)
        self.assertTrue(restored.data["restored"])
        self.assertFalse(restored.data["participant"]["canOrganizerEditAvailability"])
        self.assertIsNotNone(self.row(self.full_member).response_claimed_at)

    def test_geometry_reset_keeps_claim(self):
        self.assertEqual(self.add_only().status_code, 201)
        own = self.put(
            self.full_client,
            self.full_member,
            {
                "availabilityInperson": [1, 0],
                "submitted": 1,
                "expectedVersion": self.version(self.full_member),
            },
        )
        self.assertEqual(own.status_code, 200, own.data)
        self.event.refresh_from_db()
        moved = self.organizer_client.put(
            f"/events?code={self.event.code}",
            {"expectedVersion": self.event.version, "days": [3], "resetResponses": True},
            format="json",
        )
        self.assertEqual(moved.status_code, 200, moved.data)
        self.assertEqual(moved.data["responsesReset"], 1)
        row = self.row(self.full_member)
        self.assertFalse(row.submitted)
        self.assertIsNotNone(row.response_claimed_at)
        self.assert_owned_denial(self.organizer_write(self.full_member))

    def test_roster_flag_adds_no_queries(self):
        def counts():
            with CaptureQueriesContext(connection) as roster:
                response = self.organizer_client.get(f"/events/roster?code={self.event.code}")
            self.assertEqual(response.status_code, 200)
            with CaptureQueriesContext(connection) as listing:
                response = self.organizer_client.get(f"/events/participants?code={self.event.code}")
            self.assertEqual(response.status_code, 200)
            return len(roster), len(listing), len(response.data["participants"])

        self.assertEqual(self.add_only().status_code, 201)
        roster_one, listing_one, listed = counts()
        self.assertEqual(listed, 1)
        for index in range(5):
            member = self.fresh_full_account(f"count-{index}")
            if index % 2:
                self.assertEqual(
                    client_for(member)
                    .post(f"/events/participants?code={self.event.code}", {})
                    .status_code,
                    200,
                )
        roster_six, listing_six, listed = counts()
        self.assertEqual(listed, 6)
        self.assertEqual(roster_six, roster_one)
        self.assertEqual(listing_six, listing_one)

    @patch("apps.authn.services.email.send_email.send_verification_email")
    @patch("apps.authn.services.email.challenges._random_code", return_value="654321")
    def test_upgrade_claims_every_participation(self, _random_code, _send):
        cache.clear()
        second = self.create_event("OWNED002")
        email = "upgrade@example.com"
        added = self.add_only(email, name="Upgrade Person")
        self.assertEqual(added.status_code, 201, added.data)
        self.assertEqual(added.data["participant"]["accountAccess"], "temporary")
        self.assertEqual(self.add_only(email, event=second, name="Upgrade Person").status_code, 201)
        member = ContactEmail.objects.get(email_address=email).member

        entered = self.organizer_write(member)
        self.assertEqual(entered.status_code, 200, entered.data)
        self.assertIsNone(EventInvitation.objects.get(event=self.event, member=member).accepted_at)
        before = {row.pk: row.updated_at for row in Participant.objects.filter(member=member)}

        auth_client = APIClient()
        requested = auth_client.post(
            "/authn/email-auth/request-code/",
            {
                "email": email,
                "source": "event_registration",
                "event": self.event.code,
                "next": f"/event?code={self.event.code}",
            },
            format="json",
        )
        self.assertEqual(requested.status_code, 202, requested.data)
        verified = auth_client.post(
            "/authn/email-auth/verify-code/",
            {"email": email, "code": "654321"},
            format="json",
        )
        self.assertEqual(verified.status_code, 200, verified.data)
        member.refresh_from_db()
        self.assertEqual(member.access_level, "full")

        rows = list(Participant.objects.filter(member=member))
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertIsNotNone(row.response_claimed_at)
            self.assertGreater(row.updated_at, before[row.pk])
        self.assert_owned_denial(self.organizer_write(member, (1, 1)))
        self.assert_owned_denial(self.organizer_write(member, (1, 1), event=second))

        third = self.create_event("OWNED003")
        later = self.add_only(email, event=third, name="Upgrade Person")
        self.assertEqual(later.status_code, 201, later.data)
        self.assertEqual(later.data["participant"]["accountAccess"], "full")
        self.assertTrue(later.data["participant"]["canOrganizerEditAvailability"])
        self.assertEqual(self.organizer_write(member, event=third).status_code, 200)
