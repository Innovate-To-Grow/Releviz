import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.core import mail
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail
from apps.authn.security import RateLimitDecision, consume_request_rate_limit
from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.mail.services import dispatch_due_email_jobs, enqueue_email_job
from apps.scheduling.models import Event, EventInvitation, Participant
from apps.scheduling.services.invitations import (
    EventEmailRequestError,
    create_or_reuse_managed_participant,
    mark_invitation_for_member,
    send_roster_invitations,
)
from apps.scheduling.views import RosterInvitationsView


class RosterInvitationApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("roster-owner@example.com", "Roster", "Owner")
        self.outsider = create_member("roster-outsider@example.com", "Other", "Person")
        self.event = Event.objects.create(
            code="SENDSEL1",
            name="Send to selected",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        self.authenticate(self.organizer)

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def add_person(self, name, email, *, event=None):
        return create_or_reuse_managed_participant(
            event=event or self.event,
            organizer=self.organizer,
            name=name,
            email=email,
        )["participant"]

    def send_url(self, event=None):
        return f"/events/roster/invitations?code={(event or self.event).code}"

    def send(self, participant_ids, *, resend=None, key=None):
        payload = {
            "participantIds": participant_ids,
            "idempotencyKey": str(key or uuid.uuid4()),
        }
        if resend is not None:
            payload["resend"] = resend
        return self.client.post(self.send_url(), payload, format="json")

    def roster_statuses(self, query=""):
        response = self.client.get(f"/events/roster?code={self.event.code}{query}")
        self.assertEqual(response.status_code, 200, response.data)
        return {item["email"]: item["invitationStatus"] for item in response.data["participants"]}

    def participant_statuses(self):
        response = self.client.get(f"/events/participants?code={self.event.code}")
        self.assertEqual(response.status_code, 200, response.data)
        return {item["email"]: item["invitationStatus"] for item in response.data["participants"]}

    def test_send_to_selected_queues_skips_already_sent_and_resends_on_request(self):
        ada = self.add_person("Ada", "ada@example.com")
        grace = self.add_person("Grace", "grace@example.com")
        self.assertEqual(
            self.roster_statuses(),
            {"ada@example.com": "not_sent", "grace@example.com": "not_sent"},
        )

        first = self.send([ada.pk, str(grace.member_id)])
        self.assertEqual(first.status_code, 202, first.data)
        self.assertEqual(first.data["requestedCount"], 2)
        self.assertEqual(first.data["queuedCount"], 2)
        self.assertEqual(first.data["skippedCount"], 0)
        self.assertFalse(first.data["idempotent"])
        self.assertEqual(first.data["deliveryRequest"]["operation"], "invitation")
        self.assertEqual(first.data["deliveryRequest"]["recipientCount"], 2)
        self.assertEqual(first.data["deliveryRequest"]["enqueued"], 2)
        self.assertEqual(first.data["deliveryRequest"]["delivery"]["pending"], 2)
        jobs = EmailDeliveryJob.objects.filter(
            event=self.event,
            message_type=EmailMessageLog.MessageType.INVITATION,
        )
        self.assertEqual(
            sorted(jobs.values_list("recipient", flat=True)),
            ["ada@example.com", "grace@example.com"],
        )
        self.assertEqual(len(mail.outbox), 0)
        self.assertEqual(
            self.roster_statuses(),
            {"ada@example.com": "not_sent", "grace@example.com": "not_sent"},
        )

        in_flight = self.send([ada.pk, grace.pk])
        self.assertEqual(in_flight.status_code, 202, in_flight.data)
        self.assertEqual(in_flight.data["requestedCount"], 2)
        self.assertEqual(in_flight.data["queuedCount"], 0)
        self.assertEqual(in_flight.data["skippedCount"], 2)
        self.assertEqual(in_flight.data["deliveryRequest"]["recipientCount"], 0)
        self.assertEqual(in_flight.data["deliveryRequest"]["enqueued"], 0)
        self.assertEqual(jobs.count(), 2)
        self.assertEqual(EmailDeliveryRequest.objects.filter(event=self.event).count(), 2)
        roster = self.client.get(f"/events/roster?code={self.event.code}")
        self.assertEqual(
            roster.data["latestDeliveryRequest"]["id"],
            first.data["deliveryRequest"]["id"],
        )

        dispatched = dispatch_due_email_jobs(limit=10)
        self.assertEqual(dispatched["sent"], 2)
        self.assertEqual(
            {message.to[0] for message in mail.outbox},
            {"ada@example.com", "grace@example.com"},
        )
        self.assertEqual(
            EventInvitation.objects.filter(event=self.event, first_sent_at__isnull=False).count(),
            2,
        )
        self.assertEqual(
            self.roster_statuses(),
            {"ada@example.com": "sent", "grace@example.com": "sent"},
        )

        already_sent = self.send([ada.pk, grace.pk], resend=False)
        self.assertEqual(already_sent.status_code, 202, already_sent.data)
        self.assertEqual(already_sent.data["queuedCount"], 0)
        self.assertEqual(already_sent.data["skippedCount"], 2)
        self.assertEqual(jobs.count(), 2)

        resent = self.send([ada.pk, grace.pk], resend=True)
        self.assertEqual(resent.status_code, 202, resent.data)
        self.assertEqual(resent.data["requestedCount"], 2)
        self.assertEqual(resent.data["queuedCount"], 2)
        self.assertEqual(resent.data["skippedCount"], 0)
        self.assertEqual(resent.data["deliveryRequest"]["delivery"]["pending"], 2)
        self.assertEqual(jobs.count(), 4)
        self.assertEqual(dispatch_due_email_jobs(limit=10)["sent"], 2)
        self.assertEqual(len(mail.outbox), 4)

    def test_failed_deliveries_are_requeued_while_in_flight_jobs_are_skipped(self):
        ada = self.add_person("Ada", "ada@example.com")
        invitation = EventInvitation.objects.get(event=self.event, member=ada.member)
        initial = self.send([ada.pk])
        self.assertEqual(initial.status_code, 202, initial.data)
        self.assertEqual(initial.data["queuedCount"], 1)
        jobs = EmailDeliveryJob.objects.filter(invitation=invitation)

        for status in [
            EmailDeliveryJob.Status.PENDING,
            EmailDeliveryJob.Status.PROCESSING,
            EmailDeliveryJob.Status.RETRY,
        ]:
            with self.subTest(status=status):
                jobs.update(status=status)
                skipped = self.send([ada.pk])
                self.assertEqual(skipped.status_code, 202, skipped.data)
                self.assertEqual(skipped.data["requestedCount"], 1)
                self.assertEqual(skipped.data["queuedCount"], 0)
                self.assertEqual(skipped.data["skippedCount"], 1)
                self.assertEqual(jobs.count(), 1)

        expected_jobs = 1
        for status in [
            EmailDeliveryJob.Status.PERMANENT_FAILURE,
            EmailDeliveryJob.Status.UNCERTAIN,
            EmailDeliveryJob.Status.CANCELED,
        ]:
            with self.subTest(status=status):
                jobs.update(status=status)
                requeued = self.send([ada.pk])
                self.assertEqual(requeued.status_code, 202, requeued.data)
                self.assertEqual(requeued.data["queuedCount"], 1)
                self.assertEqual(requeued.data["skippedCount"], 0)
                expected_jobs += 1
                self.assertEqual(jobs.count(), expected_jobs)
                self.assertEqual(
                    jobs.filter(status=EmailDeliveryJob.Status.PENDING).count(),
                    1,
                )

        jobs.update(status=EmailDeliveryJob.Status.CANCELED)
        enqueue_email_job(
            idempotency_key="roster-invitations-reminder",
            message_type=EmailMessageLog.MessageType.REMINDER,
            recipient="ada@example.com",
            subject="Reminder",
            body="reminder",
            message_id="<roster-invitations-reminder@releviz.local>",
            event=self.event,
            invitation=invitation,
        )
        reminder_only = self.send([ada.pk])
        self.assertEqual(reminder_only.status_code, 202, reminder_only.data)
        self.assertEqual(reminder_only.data["queuedCount"], 1)
        invitation.refresh_from_db()
        self.assertIsNone(invitation.first_sent_at)
        self.assertEqual(self.roster_statuses(), {"ada@example.com": "not_sent"})

    def test_other_event_ids_match_nothing_and_hidden_rows_are_still_sent(self):
        hidden = self.add_person("Hidden", "hidden@example.com")
        Participant.objects.filter(pk=hidden.pk).update(hidden=True)
        other_event = Event.objects.create(
            code="OTHERSEL",
            name="Other event",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            days=[2],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        foreign = self.add_person("Foreign", "foreign@example.com", event=other_event)

        response = self.send([hidden.pk, foreign.pk, str(foreign.member_id)])
        self.assertEqual(response.status_code, 202, response.data)
        self.assertEqual(response.data["requestedCount"], 1)
        self.assertEqual(response.data["queuedCount"], 1)
        self.assertEqual(response.data["skippedCount"], 0)
        self.assertEqual(
            list(EmailDeliveryJob.objects.values_list("recipient", flat=True)),
            ["hidden@example.com"],
        )
        self.assertFalse(EmailDeliveryJob.objects.filter(event=other_event).exists())
        self.assertFalse(EmailDeliveryRequest.objects.filter(event=other_event).exists())
        self.assertEqual(self.roster_statuses(), {"hidden@example.com": "not_sent"})
        self.assertEqual(self.participant_statuses(), {})

    def test_resend_keeps_the_custom_message_set_through_the_invitations_endpoint(self):
        ada = self.add_person("Ada", "ada@example.com")
        messaged = self.client.post(
            f"/events/invitations?code={self.event.code}",
            {
                "emails": ["ada@example.com"],
                "message": "Bring your notes.",
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertEqual(messaged.status_code, 202, messaged.data)
        invitation = EventInvitation.objects.get(event=self.event, email="ada@example.com")
        self.assertEqual(invitation.custom_message, "Bring your notes.")
        self.assertEqual(dispatch_due_email_jobs(limit=10)["sent"], 1)
        self.assertIn("Bring your notes.", mail.outbox[-1].body)
        self.assertEqual(self.roster_statuses(), {"ada@example.com": "sent"})

        resent = self.send([ada.pk], resend=True)
        self.assertEqual(resent.status_code, 202, resent.data)
        self.assertEqual(resent.data["queuedCount"], 1)
        invitation.refresh_from_db()
        self.assertEqual(invitation.custom_message, "Bring your notes.")
        self.assertEqual(invitation.invited_by, self.organizer)
        self.assertEqual(dispatch_due_email_jobs(limit=10)["sent"], 1)
        self.assertIn("Bring your notes.", mail.outbox[-1].body)
        self.assertEqual(len(mail.outbox), 2)

    def test_people_without_an_invitation_row_fall_back_to_their_primary_email(self):
        direct_member = create_member("direct@example.com", "Direct", "Person")
        direct = Participant.objects.create(
            event=self.event,
            member=direct_member,
            participant_name="Direct",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        blank_member = create_member("blank@example.com", "Blank", "Person")
        ContactEmail.objects.filter(member=blank_member).delete()
        blank = Participant.objects.create(
            event=self.event,
            member=blank_member,
            participant_name="Blank",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        self.assertFalse(EventInvitation.objects.filter(event=self.event).exists())

        response = self.send([direct.pk, blank.pk])
        self.assertEqual(response.status_code, 202, response.data)
        self.assertEqual(response.data["requestedCount"], 2)
        self.assertEqual(response.data["queuedCount"], 1)
        self.assertEqual(response.data["skippedCount"], 1)
        invitation = EventInvitation.objects.get(event=self.event)
        self.assertEqual(invitation.email, "direct@example.com")
        self.assertEqual(invitation.member, direct_member)
        self.assertEqual(invitation.invited_by, self.organizer)
        self.assertEqual(invitation.custom_message, "")
        self.assertEqual(EmailDeliveryJob.objects.get().recipient, "direct@example.com")

        nothing = self.send([blank.pk])
        self.assertEqual(nothing.status_code, 202, nothing.data)
        self.assertEqual(nothing.data["requestedCount"], 1)
        self.assertEqual(nothing.data["queuedCount"], 0)
        self.assertEqual(nothing.data["skippedCount"], 1)
        self.assertFalse(nothing.data["idempotent"])
        self.assertEqual(nothing.data["deliveryRequest"]["recipientCount"], 0)
        self.assertEqual(nothing.data["deliveryRequest"]["enqueued"], 0)
        self.assertEqual(nothing.data["deliveryRequest"]["delivery"]["total"], 0)
        empty_request = EmailDeliveryRequest.objects.get(pk=nothing.data["deliveryRequest"]["id"])
        self.assertEqual(empty_request.recipient_count, 0)
        self.assertEqual(empty_request.created_job_count, 0)
        self.assertEqual(EmailDeliveryJob.objects.count(), 1)

    def test_endpoint_validates_payloads_and_guards_actor_and_lifecycle(self):
        request = SimpleNamespace(user=self.organizer)
        self.assertEqual(
            RosterInvitationsView().get_auth_rate_identity(request),
            str(self.organizer.pk),
        )
        ada = self.add_person("Ada", "ada@example.com")

        self.assertEqual(
            self.client.post("/events/roster/invitations", {}, format="json").status_code,
            400,
        )
        self.assertEqual(
            self.client.post(
                "/events/roster/invitations?code=MISSING", {}, format="json"
            ).status_code,
            404,
        )
        key = str(uuid.uuid4())
        for payload, message in [
            ({"idempotencyKey": key}, "participantIds must be a non-empty array."),
            (
                {"participantIds": [], "idempotencyKey": key},
                "participantIds must be a non-empty array.",
            ),
            (
                {"participantIds": str(ada.pk), "idempotencyKey": key},
                "participantIds must be a non-empty array.",
            ),
            (
                {"participantIds": [ada.pk], "resend": "yes", "idempotencyKey": key},
                "resend must be a boolean.",
            ),
            ({"participantIds": [ada.pk]}, "idempotencyKey must be a UUID"),
            (
                {"participantIds": [ada.pk], "idempotencyKey": "not-a-uuid"},
                "idempotencyKey must be a UUID",
            ),
            (
                {"participantIds": ["not-an-identity"], "idempotencyKey": key},
                "A participant id is invalid.",
            ),
        ]:
            with self.subTest(payload=payload):
                response = self.client.post(self.send_url(), payload, format="json")
                self.assertEqual(response.status_code, 400, response.data)
                self.assertEqual(response.data["error"], message)

        with patch("apps.scheduling.views.roster.invitations.MAX_ROSTER_ROWS", 1):
            too_many = self.send([ada.pk, str(ada.member_id)])
        self.assertEqual(too_many.status_code, 400)
        self.assertEqual(too_many.data["error"], "participantIds may contain at most 1 entries.")

        with patch(
            "apps.scheduling.views.roster.invitations.send_roster_invitations",
            side_effect=ValueError("invalid participant identifier"),
        ):
            invalid_value = self.send([ada.pk])
        self.assertEqual(invalid_value.status_code, 400)
        self.assertEqual(invalid_value.data["error"], "A participant id is invalid.")

        self.authenticate(self.outsider)
        forbidden = self.send([ada.pk])
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(forbidden.data["error"], "Only the organizer can manage the roster")
        self.authenticate(self.organizer)

        self.event.status = Event.Status.CLOSED
        self.event.closed_at = timezone.now()
        self.event.save(update_fields=["status", "closed_at", "updated_at"])
        closed = self.send([ada.pk])
        self.assertEqual(closed.status_code, 409)
        self.assertEqual(closed.data["error"], "Responses cannot change while the event is closed.")

        self.assertFalse(EmailDeliveryRequest.objects.filter(event=self.event).exists())
        self.assertFalse(EmailDeliveryJob.objects.exists())
        self.assertEqual(len(mail.outbox), 0)

    def test_service_rejects_non_organizers_locked_events_and_oversized_selections(self):
        ada = self.add_person("Ada", "ada@example.com")

        with self.assertRaisesMessage(
            EventEmailRequestError, "Only the organizer can manage invitations."
        ) as denied:
            send_roster_invitations(
                event=self.event,
                organizer=self.outsider,
                participant_ids=[ada.pk],
                resend=False,
                idempotency_key=uuid.uuid4(),
            )
        self.assertEqual(denied.exception.status_code, 403)

        with (
            override_settings(ROSTER_IMPORT_MAX_ROWS=1),
            self.assertRaisesMessage(
                EventEmailRequestError, "participantIds may contain at most 1 entries."
            ) as capped,
        ):
            send_roster_invitations(
                event=self.event,
                organizer=self.organizer,
                participant_ids=[ada.pk, str(ada.member_id)],
                resend=False,
                idempotency_key=uuid.uuid4(),
            )
        self.assertEqual(capped.exception.status_code, 400)

        self.event.status = Event.Status.CLOSED
        self.event.closed_at = timezone.now()
        self.event.save(update_fields=["status", "closed_at", "updated_at"])
        with self.assertRaisesMessage(
            EventEmailRequestError, "Responses cannot change while the event is closed."
        ) as locked:
            send_roster_invitations(
                event=self.event,
                organizer=self.organizer,
                participant_ids=[ada.pk],
                resend=False,
                idempotency_key=uuid.uuid4(),
            )
        self.assertEqual(locked.exception.status_code, 409)
        self.assertFalse(EmailDeliveryRequest.objects.exists())
        self.assertFalse(EmailDeliveryJob.objects.exists())

    def test_replay_fingerprint_mismatch_and_recipient_quota(self):
        ada = self.add_person("Ada", "ada@example.com")
        grace = self.add_person("Grace", "grace@example.com")
        key = uuid.uuid4()

        with patch(
            "apps.scheduling.views.roster.invitations.consume_request_rate_limit",
            wraps=consume_request_rate_limit,
        ) as consume:
            first = self.send([ada.pk, grace.pk], key=key)
        self.assertEqual(first.status_code, 202, first.data)
        self.assertFalse(first.data["idempotent"])
        consume.assert_called_once()
        self.assertEqual(consume.call_args.args[0], "invitation_recipient")
        self.assertEqual(consume.call_args.args[2], str(self.organizer.pk))
        self.assertEqual(consume.call_args.kwargs, {"cost": 2})
        self.assertEqual(EmailDeliveryJob.objects.count(), 2)

        denied = RateLimitDecision(allowed=False, retry_after=9)
        with patch(
            "apps.scheduling.views.roster.invitations.consume_request_rate_limit",
            return_value=denied,
        ) as consume:
            replay = self.send([grace.pk, ada.pk], key=key)
        self.assertEqual(replay.status_code, 202, replay.data)
        self.assertTrue(replay.data["idempotent"])
        self.assertEqual(replay.data["deliveryRequest"]["id"], first.data["deliveryRequest"]["id"])
        self.assertEqual(replay.data["requestedCount"], 2)
        self.assertEqual(replay.data["queuedCount"], 2)
        self.assertEqual(replay.data["skippedCount"], 0)
        self.assertEqual(replay.data["deliveryRequest"]["delivery"]["pending"], 2)
        consume.assert_not_called()
        self.assertEqual(EmailDeliveryJob.objects.count(), 2)
        self.assertEqual(EmailDeliveryRequest.objects.count(), 1)

        for participant_ids, resend in [
            ([ada.pk], None),
            ([ada.pk, grace.pk], True),
            ([ada.pk, str(grace.member_id)], None),
        ]:
            with self.subTest(participant_ids=participant_ids, resend=resend):
                mismatch = self.send(participant_ids, key=key, resend=resend)
                self.assertEqual(mismatch.status_code, 409, mismatch.data)
                self.assertEqual(
                    mismatch.data["error"],
                    "This idempotency key was already used with different invitation details.",
                )
        self.assertEqual(EmailDeliveryJob.objects.count(), 2)
        self.assertEqual(EmailDeliveryRequest.objects.count(), 1)

        with (
            patch(
                "apps.scheduling.views.roster.invitations.consume_request_rate_limit",
                return_value=denied,
            ) as consume,
            patch("apps.scheduling.views.roster.invitations.send_roster_invitations") as service,
        ):
            throttled = self.send([ada.pk, grace.pk])
        self.assertEqual(throttled.status_code, 429)
        self.assertEqual(throttled["Retry-After"], "9")
        consume.assert_called_once()
        self.assertEqual(consume.call_args.kwargs, {"cost": 2})
        service.assert_not_called()
        self.assertEqual(EmailDeliveryRequest.objects.count(), 1)

        Participant.objects.filter(pk=grace.pk).delete()
        shrunk = self.send([ada.pk, grace.pk], key=key)
        self.assertEqual(shrunk.status_code, 202, shrunk.data)
        self.assertTrue(shrunk.data["idempotent"])
        self.assertEqual(shrunk.data["requestedCount"], 1)
        self.assertEqual(shrunk.data["queuedCount"], 2)
        self.assertEqual(shrunk.data["skippedCount"], 0)

    def test_invitation_status_follows_dispatch_and_participant_responses(self):
        ada = self.add_person("Ada", "ada@example.com")
        grace = self.add_person("Grace", "grace@example.com")
        self.assertEqual(
            self.roster_statuses(),
            {"ada@example.com": "not_sent", "grace@example.com": "not_sent"},
        )
        self.assertEqual(
            self.participant_statuses(),
            {"ada@example.com": "not_sent", "grace@example.com": "not_sent"},
        )

        entered = self.client.put(
            (f"/events/participants/update?code={self.event.code}&participantId={grace.member_id}"),
            {
                "availabilityInperson": [1, 0],
                "submitted": 1,
                "expectedVersion": grace.version,
            },
            format="json",
        )
        self.assertEqual(entered.status_code, 200, entered.data)
        self.assertEqual(entered.data["participant"]["submitted"], 1)
        self.assertEqual(entered.data["participant"]["invitationStatus"], "not_sent")
        grace_invitation = EventInvitation.objects.get(event=self.event, member=grace.member)
        self.assertEqual(grace_invitation.status, EventInvitation.Status.SUBMITTED)
        self.assertIsNotNone(grace_invitation.accepted_at)
        self.assertIsNone(grace_invitation.first_sent_at)
        self.assertEqual(self.roster_statuses()["grace@example.com"], "not_sent")
        self.assertEqual(self.participant_statuses()["grace@example.com"], "not_sent")
        self.assertEqual(
            self.roster_statuses("&invitationStatus=not_sent&submitted=true"),
            {"grace@example.com": "not_sent"},
        )

        queued = self.send([ada.pk])
        self.assertEqual(queued.status_code, 202, queued.data)
        self.assertEqual(queued.data["queuedCount"], 1)
        self.assertEqual(self.roster_statuses()["ada@example.com"], "not_sent")
        self.assertEqual(dispatch_due_email_jobs(limit=10)["sent"], 1)
        self.assertEqual(self.roster_statuses()["ada@example.com"], "sent")
        self.assertEqual(self.participant_statuses()["ada@example.com"], "sent")
        readded = self.client.post(
            f"/events/participants/managed?code={self.event.code}",
            {
                "name": "Ada",
                "email": "ada@example.com",
                "idempotencyKey": str(uuid.uuid4()),
                "sendInvitation": False,
            },
            format="json",
        )
        self.assertEqual(readded.status_code, 200, readded.data)
        self.assertFalse(readded.data["created"])
        self.assertEqual(readded.data["participant"]["invitationStatus"], "sent")
        self.assertEqual(
            self.roster_statuses("&invitationStatus=sent"), {"ada@example.com": "sent"}
        )

        mark_invitation_for_member(event=self.event, member=ada.member)
        self.assertEqual(self.roster_statuses()["ada@example.com"], "accepted")
        self.assertEqual(self.participant_statuses()["ada@example.com"], "accepted")
        self.assertEqual(
            self.roster_statuses("&invitationStatus=accepted"),
            {"ada@example.com": "accepted"},
        )
        self.assertEqual(self.roster_statuses("&invitationStatus=sent"), {})

        resend_grace = self.send([grace.pk])
        self.assertEqual(resend_grace.data["queuedCount"], 1)
        self.assertEqual(dispatch_due_email_jobs(limit=10)["sent"], 1)
        self.assertEqual(self.roster_statuses()["grace@example.com"], "accepted")
        self.assertEqual(self.participant_statuses()["grace@example.com"], "accepted")
