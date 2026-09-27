"""The email an invitation or reminder preview shows: exactly what is sent, minus the private link."""

import uuid
from datetime import timedelta

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail
from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.scheduling.models import Event, EventInvitation, Participant, UserEvent
from apps.scheduling.services.invitations import (
    create_or_reuse_managed_participant,
    enqueue_reminder_job,
    invitation_link,
)
from apps.scheduling.services.invitations.links import preview_invitation_link

FRONTEND = "https://app.releviz.test"
SENDER = "noreply@releviz.test"


def without_token(value: str, invitation: EventInvitation) -> str:
    """``value`` with the invitation's private token swapped for the preview stand-in."""

    return value.replace(str(invitation.access_token), "preview")


@override_settings(FRONTEND_URL=FRONTEND, DEFAULT_FROM_EMAIL=SENDER)
class RosterInvitationEmailPreviewTests(TestCase):
    maxDiff = None

    def setUp(self):
        self.organizer = create_member("email-preview-owner@example.com", "Olive", "Organizer")
        self.client = APIClient()
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(self.organizer)}")
        self.event = Event.objects.create(
            code="EMAILPV1",
            name="Planning day",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            response_deadline=timezone.now() + timedelta(days=7),
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

    def post(self, payload):
        return self.client.post(
            f"/events/roster/invitations?code={self.event.code}",
            payload,
            format="json",
        )

    def preview(self, people, **extra):
        response = self.post(
            {"participantIds": [str(person.pk) for person in people], "preview": True, **extra}
        )
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def send(self, people):
        response = self.post(
            {
                "participantIds": [str(person.pk) for person in people],
                "idempotencyKey": str(uuid.uuid4()),
            }
        )
        self.assertEqual(response.status_code, 202, response.data)
        return response.data

    def stored_counts(self):
        return (
            EventInvitation.objects.count(),
            EmailDeliveryJob.objects.count(),
            EmailDeliveryRequest.objects.count(),
        )

    def assert_matches_the_send(self, email, invitation):
        """The preview is the queued invitation, token for token."""

        job = EmailDeliveryJob.objects.get(
            invitation=invitation, message_type=EmailMessageLog.MessageType.INVITATION
        )
        self.assertIn(str(invitation.access_token), job.body)
        self.assertIn(str(invitation.access_token), job.html_body)
        self.assertEqual(email["subject"], job.subject)
        self.assertEqual(email["text"], without_token(job.body, invitation))
        self.assertEqual(email["html"], without_token(job.html_body, invitation))
        self.assertEqual(
            email["attachments"], [attachment["filename"] for attachment in job.attachments]
        )

    def test_preview_shows_the_first_email_the_send_queues_without_writing(self):
        managed = self.add_person("Kim", managed=True)
        ada = self.add_person("Ada Lovelace", "ada@example.com")
        grace = self.add_person("Grace", "grace@example.com")
        ada_invitation = self.invitation_for(ada)
        ada_invitation.custom_message = "Bring your calendar & <notes>"
        ada_invitation.save(update_fields=["custom_message", "updated_at"])
        before = self.stored_counts()

        preview = self.preview([grace, managed, ada])

        self.assertEqual(self.stored_counts(), before)
        self.assertEqual(preview["willSend"], 2)
        # The send walks the selection in roster order, so Ada (added before
        # Grace) is the first email out; Kim has no address of their own.
        self.assertEqual(preview["sample"], {"name": "Ada Lovelace", "email": "ada@example.com"})
        email = preview["email"]
        self.assertEqual(email["from"], SENDER)
        self.assertEqual(email["replyTo"], "")
        self.assertEqual(email["to"], "Ada Lovelace <ada@example.com>")
        self.assertEqual(email["subject"], "Share your availability for Planning day")
        self.assertEqual(email["attachments"], ["releviz-EMAILPV1-availability.ics"])
        # Ada has a temporary account: the access-code page and its instructions.
        preview_link = f"{FRONTEND}/temp-access?code=EMAILPV1&invitation=preview"
        self.assertIn(f"Link: {preview_link}\n", email["text"])
        self.assertIn("enter the six-digit code", email["text"])
        self.assertIn("Message from organizer:\nBring your calendar & <notes>", email["text"])
        self.assertIn("Bring your calendar &amp; &lt;notes&gt;", email["html"])
        self.assertIn("invitation=preview", email["html"])
        self.assertTrue(email["html"].lstrip().lower().startswith("<!doctype html"))
        for field in ("text", "html"):
            self.assertNotIn(str(ada_invitation.access_token), email[field])

        self.send([grace, managed, ada])
        self.assert_matches_the_send(email, ada_invitation)

    def test_someone_without_an_invitation_previews_the_account_variant(self):
        member = create_member("joined@example.com", "Joe", "Joined")
        joe = Participant.objects.create(
            event=self.event,
            member=member,
            participant_name="Joe Joined",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        before = self.stored_counts()

        preview = self.preview([joe])

        self.assertEqual(self.stored_counts(), before)
        self.assertFalse(EventInvitation.objects.filter(email="joined@example.com").exists())
        self.assertEqual(preview["sample"], {"name": "Joe Joined", "email": "joined@example.com"})
        email = preview["email"]
        self.assertIn(f"Link: {FRONTEND}/event?code=EMAILPV1&invitation=preview\n", email["text"])
        self.assertIn("Log in or create a Releviz account", email["text"])
        self.assertNotIn("Message from organizer", email["text"])
        self.assertNotIn("six-digit code", email["html"])

        self.send([joe])
        self.assert_matches_the_send(
            email, EventInvitation.objects.get(event=self.event, email="joined@example.com")
        )

    def test_a_full_account_previews_the_account_variant(self):
        create_member("grace@example.com", "Grace", "Hopper")
        grace = self.add_person("Grace Hopper", "grace@example.com")

        email = self.preview([grace])["email"]

        self.assertIn(f"{FRONTEND}/event?code=EMAILPV1&invitation=preview", email["text"])
        self.assertIn("Log in or create a Releviz account", email["text"])
        self.send([grace])
        self.assert_matches_the_send(email, self.invitation_for(grace))

    def test_nobody_to_email_previews_no_email(self):
        ada = self.add_person("Ada", "ada@example.com")
        managed = self.add_person("Kim", managed=True)
        invitation = self.invitation_for(ada)
        invitation.first_sent_at = timezone.now()
        invitation.save(update_fields=["first_sent_at", "updated_at"])

        nobody = self.preview([ada, managed])
        self.assertEqual(nobody["willSend"], 0)
        self.assertIsNone(nobody["email"])
        self.assertIsNone(nobody["sample"])

        # Emailing the already invited again previews their email.
        again = self.preview([ada, managed], resend=True)
        self.assertEqual(again["willSend"], 1)
        self.assertEqual(again["sample"], {"name": "Ada", "email": "ada@example.com"})
        self.assertEqual(again["email"]["to"], "Ada <ada@example.com>")

    def test_links_keep_their_page_and_drop_the_token(self):
        temporary = self.invitation_for(self.add_person("Ada", "ada@example.com"))
        create_member("grace@example.com", "Grace", "Hopper")
        full = self.invitation_for(self.add_person("Grace", "grace@example.com"))
        unlinked = EventInvitation(event=self.event, email="nobody@example.com")
        for invitation, page in ((temporary, "temp-access"), (full, "event"), (unlinked, "event")):
            with self.subTest(email=invitation.email):
                self.assertEqual(
                    preview_invitation_link(invitation),
                    f"{FRONTEND}/{page}?code=EMAILPV1&invitation=preview",
                )
                self.assertEqual(
                    invitation_link(invitation),
                    f"{FRONTEND}/{page}?code=EMAILPV1&invitation={invitation.access_token}",
                )


@override_settings(FRONTEND_URL=FRONTEND, DEFAULT_FROM_EMAIL=SENDER)
class ReminderEmailPreviewTests(TestCase):
    maxDiff = None

    def setUp(self):
        self.organizer = create_member("reminder-email-owner@example.com", "Olive", "Owner")
        self.event = Event.objects.create(
            code="REMEMAIL",
            name="Reminder day",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            response_deadline=timezone.now() + timedelta(days=2),
        )
        self.client = APIClient()
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(self.organizer)}")
        # Bea answers through a temporary account on the roster; Abe was
        # invited by address only. Candidates go out in address order.
        bea_member = create_member(
            "bea@example.com", "Bea", "Temp", access_level="temporary", contact_verified=False
        )
        Participant.objects.create(
            event=self.event,
            member=bea_member,
            participant_name="Bea Roster",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        self.bea = self.invite("bea@example.com", member=bea_member)
        self.abe = self.invite("abe@example.com")
        self.invite("aaron@example.com", status=EventInvitation.Status.SUBMITTED)
        self.invite("adam@example.com", sent=False)

    def invite(self, email, *, member=None, sent=True, status=EventInvitation.Status.INVITED):
        return EventInvitation.objects.create(
            event=self.event,
            email=email,
            member=member,
            invited_by=self.organizer,
            first_sent_at=timezone.now() if sent else None,
            status=status,
            custom_message="See you there",
        )

    def preview(self):
        response = self.client.post(
            f"/events/reminders?code={self.event.code}", {"preview": True}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertIn("no-store", response["Cache-Control"])
        return response.data

    def test_preview_shows_the_next_reminder_to_go_out(self):
        before = (EmailDeliveryJob.objects.count(), EmailDeliveryRequest.objects.count())
        preview = self.preview()
        self.assertEqual(
            (EmailDeliveryJob.objects.count(), EmailDeliveryRequest.objects.count()), before
        )
        self.assertEqual(preview["wouldEnqueue"], 2)
        # Abe was invited by address alone, so there is no roster name to show.
        self.assertEqual(preview["sample"], {"name": "", "email": "abe@example.com"})
        email = preview["email"]
        self.assertEqual(email["to"], "abe@example.com")
        self.assertEqual(email["subject"], "Reminder: share your availability for Reminder day")
        self.assertTrue(email["text"].startswith("Reminder:\n\n"))
        self.assertIn(f"{FRONTEND}/event?code=REMEMAIL&invitation=preview", email["text"])
        self.assertIn("Message from organizer:\nSee you there", email["text"])
        self.assertIn("Availability reminder", email["html"])
        self.assertNotIn(str(self.abe.access_token), email["text"] + email["html"])

        job, _created = enqueue_reminder_job(self.abe)
        self.assertEqual(email["text"], without_token(job.body, self.abe))
        self.assertEqual(email["html"], without_token(job.html_body, self.abe))
        self.assertEqual(email["subject"], job.subject)

        # Abe has had this cycle's reminder, so Bea's is the next one out, in
        # the temporary-access variant under her roster name.
        reminded = self.preview()
        self.assertEqual(reminded["wouldEnqueue"], 1)
        self.assertEqual(reminded["sample"], {"name": "Bea Roster", "email": "bea@example.com"})
        self.assertEqual(reminded["email"]["to"], "Bea Roster <bea@example.com>")
        self.assertIn(
            f"{FRONTEND}/temp-access?code=REMEMAIL&invitation=preview",
            reminded["email"]["text"],
        )
        self.assertIn("six-digit code", reminded["email"]["text"])

        # With everyone reminded the preview still shows what a run would send.
        enqueue_reminder_job(self.bea)
        everyone = self.preview()
        self.assertEqual(everyone["wouldEnqueue"], 0)
        self.assertEqual(everyone["sample"]["email"], "abe@example.com")

        EventInvitation.objects.filter(event=self.event).update(
            status=EventInvitation.Status.SUBMITTED
        )
        nobody = self.preview()
        self.assertEqual(nobody["eligible"], 0)
        self.assertIsNone(nobody["email"])
        self.assertIsNone(nobody["sample"])

    def test_a_deleted_contact_does_not_hide_the_roster_name(self):
        ContactEmail.objects.filter(email_address="bea@example.com").delete()
        EventInvitation.objects.filter(pk=self.abe.pk).update(
            status=EventInvitation.Status.SUBMITTED
        )
        preview = self.preview()
        self.assertEqual(preview["sample"], {"name": "Bea Roster", "email": "bea@example.com"})
