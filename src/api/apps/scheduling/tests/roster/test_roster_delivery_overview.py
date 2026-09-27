"""Per-row invitation delivery state, its filters, and the whole-roster ``overall`` block."""

import uuid

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail
from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.mail.services import enqueue_email_job
from apps.scheduling.models import Event, EventInvitation, Participant, UserEvent
from apps.scheduling.services.invitations import create_or_reuse_managed_participant

ORGANIZER_EMAIL = "overview-owner@example.com"


class RosterDeliveryOverviewTests(TestCase):
    def setUp(self):
        self.organizer = create_member(ORGANIZER_EMAIL, "Olive", "Organizer")
        self.client = APIClient()
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(self.organizer)}")
        self.event = Event.objects.create(
            code="OVERVW01",
            name="Overview",
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

    def add_job(self, invitation, status, *, message_type=EmailMessageLog.MessageType.INVITATION):
        key = str(uuid.uuid4())
        job, _created = enqueue_email_job(
            idempotency_key=f"overview:{key}",
            message_type=message_type,
            recipient=invitation.email,
            subject="Subject",
            body="Body",
            message_id=f"<overview-{key}@releviz.local>",
            event=self.event,
            invitation=invitation,
        )
        EmailDeliveryJob.objects.filter(pk=job.pk).update(status=status)
        return job

    def roster(self, query=""):
        response = self.client.get(f"/events/roster?code={self.event.code}{query}")
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def deliveries(self, query=""):
        return {
            item["name"]: item["invitationDelivery"] for item in self.roster(query)["participants"]
        }

    def test_invitation_delivery_follows_the_latest_invitation_job(self):
        ada = self.add_person("Ada", "ada@example.com")
        self.assertEqual(self.deliveries(), {"Ada": None})
        invitation = self.invitation_for(ada)

        expectations = [
            (EmailDeliveryJob.Status.PENDING, "queued"),
            (EmailDeliveryJob.Status.PROCESSING, "queued"),
            (EmailDeliveryJob.Status.RETRY, "queued"),
            (EmailDeliveryJob.Status.PERMANENT_FAILURE, "failed"),
            (EmailDeliveryJob.Status.SENT, None),
            (EmailDeliveryJob.Status.UNCERTAIN, None),
            (EmailDeliveryJob.Status.CANCELED, None),
        ]
        job = self.add_job(invitation, EmailDeliveryJob.Status.PENDING)
        for status, expected in expectations:
            with self.subTest(status=status):
                EmailDeliveryJob.objects.filter(pk=job.pk).update(status=status)
                self.assertEqual(self.deliveries()["Ada"], expected)

        # Only the newest invitation job counts: a fresh send after a failure
        # is queued, and a reminder job says nothing about the invitation.
        EmailDeliveryJob.objects.filter(pk=job.pk).update(
            status=EmailDeliveryJob.Status.PERMANENT_FAILURE
        )
        self.assertEqual(self.deliveries()["Ada"], "failed")
        newer = self.add_job(invitation, EmailDeliveryJob.Status.PENDING)
        self.assertEqual(self.deliveries()["Ada"], "queued")
        EmailDeliveryJob.objects.filter(pk=newer.pk).update(status=EmailDeliveryJob.Status.SENT)
        self.add_job(
            invitation,
            EmailDeliveryJob.Status.PENDING,
            message_type=EmailMessageLog.MessageType.REMINDER,
        )
        self.assertEqual(self.deliveries()["Ada"], None)

        # The per-person schedule read carries the same value.
        schedule = self.client.get(f"/events/roster/{ada.pk}/schedule?code={self.event.code}")
        self.assertEqual(schedule.status_code, 200, schedule.data)
        self.assertIsNone(schedule.data["participant"]["invitationDelivery"])

    def test_queued_and_failed_filters_select_on_delivery_state(self):
        ada = self.add_person("Ada", "ada@example.com")
        grace = self.add_person("Grace", "grace@example.com")
        self.add_person("Hal", "hal@example.com")
        self.add_job(self.invitation_for(ada), EmailDeliveryJob.Status.RETRY)
        self.add_job(self.invitation_for(grace), EmailDeliveryJob.Status.PERMANENT_FAILURE)

        self.assertEqual(self.deliveries("&invitationStatus=queued"), {"Ada": "queued"})
        self.assertEqual(self.deliveries("&invitationStatus=failed"), {"Grace": "failed"})
        self.assertEqual(
            self.deliveries("&invitationStatus=not_sent"),
            {"Ada": "queued", "Grace": "failed", "Hal": None},
        )
        # Stats follow the filter; the overall block never does.
        filtered = self.roster("&invitationStatus=failed")
        self.assertEqual(filtered["stats"]["total"], 1)
        self.assertEqual(filtered["pagination"]["total"], 1)
        self.assertEqual(filtered["overall"]["total"], 3)

        # The same values work in the bulk selector's filter.
        bulk = self.client.patch(
            f"/events/roster/bulk?code={self.event.code}",
            {
                "filter": {"invitationStatus": "failed"},
                "updates": {"group": "Bounced"},
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertEqual(bulk.status_code, 200, bulk.data)
        self.assertEqual(bulk.data["matchedCount"], 1)
        grace.refresh_from_db()
        self.assertEqual(list(grace.groups.values_list("name", flat=True)), ["Bounced"])

    def test_overall_counts_the_whole_roster_whatever_the_filters(self):
        empty = self.roster()["overall"]
        self.assertEqual(
            empty,
            {
                "total": 0,
                "submitted": 0,
                "notSubmitted": 0,
                "included": 0,
                "excluded": 0,
                "notInvited": 0,
                "sending": 0,
                "failed": 0,
                "noEmail": 0,
                "remindable": 0,
            },
        )

        # Ada: never invited, nothing queued -> a plain send would email her.
        self.add_person("Ada", "ada@example.com")
        # Grace: her invitation is on its way.
        grace = self.add_person("Grace", "grace@example.com")
        self.add_job(self.invitation_for(grace), EmailDeliveryJob.Status.PENDING)
        # Hal: delivery gave up, so a plain send tries again.
        hal = self.add_person("Hal", "hal@example.com")
        self.add_job(self.invitation_for(hal), EmailDeliveryJob.Status.PERMANENT_FAILURE)
        # Ivy: invited and yet to answer, so a reminder would reach her.
        ivy = self.add_person("Ivy", "ivy@example.com")
        ivy_invitation = self.invitation_for(ivy)
        ivy_invitation.first_sent_at = timezone.now()
        ivy_invitation.save(update_fields=["first_sent_at", "updated_at"])
        self.add_job(ivy_invitation, EmailDeliveryJob.Status.SENT)
        # Jo: invited and already submitted, so no reminder.
        jo = self.add_person("Jo", "jo@example.com")
        jo_invitation = self.invitation_for(jo)
        jo_invitation.first_sent_at = timezone.now()
        jo_invitation.status = EventInvitation.Status.SUBMITTED
        jo_invitation.save(update_fields=["first_sent_at", "status", "updated_at"])
        Participant.objects.filter(pk=jo.pk).update(submitted=True)
        # Kim: no email of their own; the organizer enters their schedule.
        self.add_person("Kim", managed=True)
        # Lee: an account with no address at all, which no send can reach.
        lee_member = create_member("lee@example.com", "Lee", "Person")
        ContactEmail.objects.filter(member=lee_member).delete()
        lee_member.email = ""
        lee_member.save(update_fields=["email"])
        Participant.objects.create(
            event=self.event,
            member=lee_member,
            participant_name="Lee",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        # The organizer's own row is never invited.
        joined = self.client.post(f"/events/participants?code={self.event.code}", {}, format="json")
        self.assertEqual(joined.status_code, 201, joined.data)

        expected = {
            "total": 8,
            "submitted": 1,
            "notSubmitted": 7,
            "included": 8,
            "excluded": 0,
            "notInvited": 2,
            "sending": 1,
            "failed": 1,
            "noEmail": 1,
            "remindable": 1,
        }
        self.assertEqual(self.roster()["overall"], expected)

        # A filter narrows stats and the page but not the overall block.
        filtered = self.roster("&submitted=true&search=jo")
        self.assertEqual(filtered["stats"]["total"], 1)
        self.assertEqual(filtered["overall"], expected)

        # Reminders being off does not change who a run would consider.
        self.event.reminders_enabled = False
        self.event.save(update_fields=["reminders_enabled", "updated_at"])
        self.assertEqual(self.roster()["overall"]["remindable"], 1)

        # Once Grace's email goes out she is neither sending nor uninvited.
        EmailDeliveryJob.objects.filter(invitation=self.invitation_for(grace)).update(
            status=EmailDeliveryJob.Status.SENT
        )
        grace_invitation = self.invitation_for(grace)
        grace_invitation.first_sent_at = timezone.now()
        grace_invitation.save(update_fields=["first_sent_at", "updated_at"])
        overall = self.roster()["overall"]
        self.assertEqual(overall["sending"], 0)
        self.assertEqual(overall["notInvited"], 2)
        self.assertEqual(overall["remindable"], 2)
