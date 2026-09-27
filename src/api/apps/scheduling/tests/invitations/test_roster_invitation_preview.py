"""Invitation sends by filter, their preview, and the skip breakdown they report."""

import uuid
from datetime import timedelta
from unittest.mock import patch

from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail
from apps.authn.security import RateLimitDecision, consume_request_rate_limit
from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.mail.services import dispatch_due_email_jobs, enqueue_email_job
from apps.scheduling.models import Event, EventInvitation, Participant, UserEvent
from apps.scheduling.services.invitations import (
    EventEmailRequestError,
    create_or_reuse_managed_participant,
    send_roster_invitations,
)

ORGANIZER_EMAIL = "preview-owner@example.com"
NO_SKIPS = {"alreadyInvited": 0, "noEmail": 0, "organizer": 0, "inFlight": 0}


class RosterInvitationPreviewTests(TestCase):
    def setUp(self):
        self.organizer = create_member(ORGANIZER_EMAIL, "Olive", "Organizer")
        self.client = APIClient()
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(self.organizer)}")
        self.event = Event.objects.create(
            code="PREVIEW1",
            name="Preview",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        UserEvent.objects.create(member=self.organizer, event=self.event, role="organizer")

    def add_person(self, name, email="", *, managed=False):
        return create_or_reuse_managed_participant(
            event=self.event,
            organizer=self.organizer,
            name=name,
            email=email,
            organizer_managed=managed,
        )["participant"]

    def invitation_for(self, participant):
        return EventInvitation.objects.get(event=self.event, member=participant.member)

    def add_job(self, invitation, status, **fields):
        key = str(uuid.uuid4())
        job, _created = enqueue_email_job(
            idempotency_key=f"preview:{key}",
            message_type=EmailMessageLog.MessageType.INVITATION,
            recipient=invitation.email,
            subject="Subject",
            body="Body",
            message_id=f"<preview-{key}@releviz.local>",
            event=self.event,
            invitation=invitation,
        )
        EmailDeliveryJob.objects.filter(pk=job.pk).update(status=status, **fields)
        return job

    def self_joined(self, index, *, primary_contact=True):
        """Someone who joined with the event code: an account, no invitation.

        Without ``primary_contact`` the account has no address on file at all.
        """

        member = create_member(f"joined-{index}@example.com", "Joined", str(index))
        if not primary_contact:
            ContactEmail.objects.filter(member=member).delete()
        return Participant.objects.create(
            event=self.event,
            member=member,
            participant_name=f"Joined {index}",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )

    def roster(self):
        response = self.client.get(f"/events/roster?code={self.event.code}")
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def mixed_roster(self):
        """One person of each kind a send tells apart; returns them by name."""

        people = {
            "Ada": self.add_person("Ada", "ada@example.com"),
            "Grace": self.add_person("Grace", "grace@example.com"),
            "Hal": self.add_person("Hal", "hal@example.com"),
            "Kim": self.add_person("Kim", managed=True),
        }
        grace_invitation = self.invitation_for(people["Grace"])
        grace_invitation.first_sent_at = timezone.now()
        grace_invitation.save(update_fields=["first_sent_at", "updated_at"])
        self.add_job(self.invitation_for(people["Hal"]), EmailDeliveryJob.Status.PENDING)
        lee_member = create_member("lee@example.com", "Lee", "Person")
        ContactEmail.objects.filter(member=lee_member).delete()
        people["Lee"] = Participant.objects.create(
            event=self.event,
            member=lee_member,
            participant_name="Lee",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        joined = self.client.post(f"/events/participants?code={self.event.code}", {}, format="json")
        self.assertEqual(joined.status_code, 201, joined.data)
        people["Olive"] = Participant.objects.get(event=self.event, member=self.organizer)
        return people

    def post(self, payload):
        return self.client.post(
            f"/events/roster/invitations?code={self.event.code}",
            payload,
            format="json",
        )

    def test_preview_classifies_the_selection_without_side_effects(self):
        people = self.mixed_roster()
        everyone = [str(person.pk) for person in people.values()]

        with patch(
            "apps.scheduling.views.roster.invitations.consume_request_rate_limit"
        ) as consume:
            preview = self.post({"participantIds": everyone, "preview": True})
        self.assertEqual(preview.status_code, 200, preview.data)
        email = preview.data.pop("email")
        self.assertEqual(
            preview.data,
            {
                "preview": True,
                "requestedCount": 6,
                "willSend": 1,
                "skipped": {"alreadyInvited": 1, "noEmail": 2, "organizer": 1, "inFlight": 1},
                # The one person the send would email, and what they would get.
                "sample": {"name": "Ada", "email": "ada@example.com"},
            },
        )
        self.assertEqual(email["to"], "Ada <ada@example.com>")
        consume.assert_not_called()
        self.assertFalse(EmailDeliveryRequest.objects.filter(event=self.event).exists())
        self.assertEqual(EmailDeliveryJob.objects.count(), 1)
        self.assertFalse(EventInvitation.objects.filter(email=ORGANIZER_EMAIL).exists())

        # Resending reaches the already invited; an email in flight still waits.
        resend = self.post({"participantIds": everyone, "preview": True, "resend": True})
        self.assertEqual(resend.status_code, 200, resend.data)
        self.assertEqual(resend.data["willSend"], 2)
        self.assertEqual(
            resend.data["skipped"],
            {"alreadyInvited": 0, "noEmail": 2, "organizer": 1, "inFlight": 1},
        )

        # A failed delivery never reached Hal, so a plain send tries again.
        EmailDeliveryJob.objects.update(status=EmailDeliveryJob.Status.PERMANENT_FAILURE)
        failed = self.post({"filter": {"invitationStatus": "failed"}, "preview": True})
        self.assertEqual(failed.status_code, 200, failed.data)
        self.assertEqual(failed.data["requestedCount"], 1)
        self.assertEqual(failed.data["willSend"], 1)
        self.assertEqual(failed.data["skipped"], NO_SKIPS)

        invalid = self.post({"participantIds": everyone, "preview": "yes"})
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.data["error"], "preview must be a boolean.")

    def test_send_reports_the_breakdown_and_charges_only_what_it_queues(self):
        people = self.mixed_roster()
        everyone = [str(person.pk) for person in people.values()]
        key = str(uuid.uuid4())
        expected_skips = {"alreadyInvited": 1, "noEmail": 2, "organizer": 1, "inFlight": 1}

        with patch(
            "apps.scheduling.views.roster.invitations.consume_request_rate_limit",
            wraps=consume_request_rate_limit,
        ) as consume:
            sent = self.post({"participantIds": everyone, "idempotencyKey": key})
        self.assertEqual(sent.status_code, 202, sent.data)
        self.assertEqual(sent.data["requestedCount"], 6)
        self.assertEqual(sent.data["queuedCount"], 1)
        self.assertEqual(sent.data["willSend"], 1)
        self.assertEqual(sent.data["skippedCount"], 5)
        self.assertEqual(sent.data["skipped"], expected_skips)
        self.assertFalse(sent.data["idempotent"])
        consume.assert_called_once()
        self.assertEqual(consume.call_args.kwargs, {"cost": 1})
        self.assertEqual(
            list(
                EmailDeliveryJob.objects.filter(
                    status=EmailDeliveryJob.Status.PENDING, recipient="ada@example.com"
                ).values_list("recipient", flat=True)
            ),
            ["ada@example.com"],
        )

        # The replay tells the same story even once Ada's email has gone out.
        self.assertEqual(dispatch_due_email_jobs(limit=10)["sent"], 2)
        self.assertIsNotNone(self.invitation_for(people["Ada"]).first_sent_at)
        with patch(
            "apps.scheduling.views.roster.invitations.consume_request_rate_limit",
            return_value=RateLimitDecision(allowed=False, retry_after=5),
        ) as consume:
            replay = self.post({"participantIds": everyone, "idempotencyKey": key})
        self.assertEqual(replay.status_code, 202, replay.data)
        self.assertTrue(replay.data["idempotent"])
        self.assertEqual(replay.data["willSend"], 1)
        self.assertEqual(replay.data["queuedCount"], 1)
        # Hal's email went out too, so he is now among the already invited.
        self.assertEqual(
            replay.data["skipped"],
            {"alreadyInvited": 2, "noEmail": 2, "organizer": 1, "inFlight": 0},
        )
        consume.assert_not_called()

        # A send that queues nobody spends nothing.
        with patch(
            "apps.scheduling.views.roster.invitations.consume_request_rate_limit",
            return_value=RateLimitDecision(allowed=False, retry_after=5),
        ) as consume:
            nothing = self.post({"participantIds": everyone, "idempotencyKey": str(uuid.uuid4())})
        self.assertEqual(nothing.status_code, 202, nothing.data)
        self.assertEqual(nothing.data["queuedCount"], 0)
        self.assertEqual(nothing.data["willSend"], 0)
        self.assertEqual(
            nothing.data["skipped"],
            {"alreadyInvited": 3, "noEmail": 2, "organizer": 1, "inFlight": 0},
        )
        consume.assert_not_called()

    def test_filter_selection_sends_to_the_matching_people(self):
        people = self.mixed_roster()
        key = str(uuid.uuid4())

        narrowed = self.post({"filter": {"search": "ada"}, "preview": True})
        self.assertEqual(narrowed.status_code, 200, narrowed.data)
        self.assertEqual(narrowed.data["requestedCount"], 1)
        self.assertEqual(narrowed.data["willSend"], 1)

        sent = self.post({"filter": {"all": True}, "resend": True, "idempotencyKey": key})
        self.assertEqual(sent.status_code, 202, sent.data)
        self.assertEqual(sent.data["requestedCount"], 6)
        self.assertEqual(sent.data["queuedCount"], 2)
        self.assertEqual(sent.data["willSend"], 2)
        self.assertEqual(
            sent.data["skipped"],
            {"alreadyInvited": 0, "noEmail": 2, "organizer": 1, "inFlight": 1},
        )
        self.assertEqual(
            sorted(
                EmailDeliveryJob.objects.filter(status=EmailDeliveryJob.Status.PENDING)
                .exclude(invitation=self.invitation_for(people["Hal"]))
                .values_list("recipient", flat=True)
            ),
            ["ada@example.com", "grace@example.com"],
        )

        replay = self.post({"filter": {"all": True}, "resend": True, "idempotencyKey": key})
        self.assertEqual(replay.status_code, 202, replay.data)
        self.assertTrue(replay.data["idempotent"])
        self.assertEqual(replay.data["willSend"], 2)
        self.assertEqual(
            replay.data["skipped"],
            {"alreadyInvited": 0, "noEmail": 2, "organizer": 1, "inFlight": 1},
        )
        mismatch = self.post({"filter": {"search": "ada"}, "resend": True, "idempotencyKey": key})
        self.assertEqual(mismatch.status_code, 409, mismatch.data)
        self.assertEqual(EmailDeliveryRequest.objects.filter(event=self.event).count(), 1)

        for payload, message in [
            ({}, "Provide participantIds or filter."),
            (
                {"participantIds": [str(people["Ada"].pk)], "filter": {"all": True}},
                "Provide participantIds or filter.",
            ),
            ({"filter": "everyone"}, "filter must be an object."),
            ({"filter": {}}, "filter must contain a participant filter or explicit all=true."),
            ({"filter": {"all": False}}, "filter.all must be true when provided."),
            ({"filter": {"bogus": 1}}, "Unknown participant filter: bogus."),
            ({"filter": {"submitted": "maybe"}}, "submitted must be true or false."),
        ]:
            with self.subTest(payload=payload):
                response = self.post({**payload, "preview": True})
                self.assertEqual(response.status_code, 400, response.data)
                self.assertEqual(response.data["error"], message)

        with override_settings(ROSTER_IMPORT_MAX_ROWS=1):
            too_many = self.post({"filter": {"all": True}, "preview": True})
        self.assertEqual(too_many.status_code, 400, too_many.data)
        self.assertEqual(too_many.data["error"], "participantIds may contain at most 1 entries.")

    def test_addresses_resolve_in_a_fixed_number_of_queries(self):
        """A preview of a large selection costs the same queries as a small one.

        People without an invitation are the ones whose address is not on an
        invitation row: someone who joined with the code, with or without a
        primary contact email, or someone the organizer manages. The whole
        selection is classified under the event lock, so their addresses must
        be looked up together, not one person at a time.
        """

        def add_people(indexes):
            for index in indexes:
                self.self_joined(index)
                self.self_joined(index + 100, primary_contact=False)
                self.add_person(f"Managed {index}", managed=True)

        def preview_everyone():
            with CaptureQueriesContext(connection) as captured:
                response = self.post({"filter": {"all": True}, "preview": True})
            self.assertEqual(response.status_code, 200, response.data)
            return response.data, [query["sql"] for query in captured.captured_queries]

        add_people(range(3))
        # A preview spends no request budget, so even the first one touches
        # no rate-limit bucket and needs no warm-up.
        small, small_queries = preview_everyone()
        self.assertEqual(small["requestedCount"], 9)
        self.assertEqual(small["willSend"], 3)
        self.assertEqual(small["skipped"], {**NO_SKIPS, "noEmail": 6})

        add_people(range(3, 13))
        large, large_queries = preview_everyone()
        self.assertEqual(large["requestedCount"], 39)
        self.assertEqual(large["willSend"], 13)
        self.assertEqual(large["skipped"], {**NO_SKIPS, "noEmail": 26})

        self.assertEqual(len(large_queries), len(small_queries))
        contact_lookups = [
            sql for sql in large_queries if sql.startswith('SELECT "authn_contactemail"')
        ]
        self.assertEqual(len(contact_lookups), 1, contact_lookups)

    def test_in_flight_skip_follows_the_newest_invitation_email(self):
        """The send skips as in flight exactly the rows the roster shows as sending.

        An earlier invitation email can still be backing off after a transient
        error when a later one for the same invitation has failed for good; the
        roster reduces that to the newest email, so the send must too, or the
        organizer could not retry the failure the list reports.
        """

        ada = self.add_person("Ada", "ada@example.com")
        invitation = self.invitation_for(ada)
        now = timezone.now()
        self.add_job(
            invitation,
            EmailDeliveryJob.Status.RETRY,
            created_at=now - timedelta(minutes=5),
            next_attempt_at=now + timedelta(hours=1),
        )
        self.add_job(invitation, EmailDeliveryJob.Status.PERMANENT_FAILURE, created_at=now)

        listing = self.roster()
        self.assertEqual(listing["participants"][0]["invitationDelivery"], "failed")
        self.assertEqual(listing["overall"]["failed"], 1)
        self.assertEqual(listing["overall"]["sending"], 0)
        self.assertEqual(listing["overall"]["notInvited"], 1)

        preview = self.post({"filter": {"invitationStatus": "failed"}, "preview": True})
        self.assertEqual(preview.status_code, 200, preview.data)
        email = preview.data.pop("email")
        self.assertEqual(
            preview.data,
            {
                "preview": True,
                "requestedCount": 1,
                "willSend": 1,
                "skipped": NO_SKIPS,
                "sample": {"name": "Ada", "email": "ada@example.com"},
            },
        )
        self.assertIn("invitation=preview", email["text"])

        sent = self.post(
            {"filter": {"invitationStatus": "failed"}, "idempotencyKey": str(uuid.uuid4())}
        )
        self.assertEqual(sent.status_code, 202, sent.data)
        self.assertEqual(sent.data["queuedCount"], 1)
        self.assertEqual(sent.data["skipped"], NO_SKIPS)
        self.assertEqual(
            EmailDeliveryJob.objects.filter(
                invitation=invitation, status=EmailDeliveryJob.Status.PENDING
            ).count(),
            1,
        )

        # Now the newest email is the one waiting to go out, and the row and
        # the send agree on that too.
        self.assertEqual(self.roster()["participants"][0]["invitationDelivery"], "queued")
        again = self.post({"participantIds": [str(ada.pk)], "preview": True, "resend": True})
        self.assertEqual(again.status_code, 200, again.data)
        self.assertEqual(again.data["willSend"], 0)
        self.assertEqual(again.data["skipped"], {**NO_SKIPS, "inFlight": 1})

    def test_service_requires_exactly_one_selector(self):
        ada = self.add_person("Ada", "ada@example.com")
        for selection in [{}, {"participant_ids": [ada.pk], "roster_filter": {"all": True}}]:
            with (
                self.subTest(selection=selection),
                self.assertRaisesMessage(
                    EventEmailRequestError, "Provide participantIds or filter."
                ),
            ):
                send_roster_invitations(
                    event=self.event,
                    organizer=self.organizer,
                    resend=False,
                    idempotency_key=uuid.uuid4(),
                    **selection,
                )
        self.assertFalse(EmailDeliveryRequest.objects.exists())
