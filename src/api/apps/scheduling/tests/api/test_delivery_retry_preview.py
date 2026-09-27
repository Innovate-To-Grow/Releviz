"""The retry preview: which failed emails a retry would send again, and what they say."""

import uuid
from datetime import timedelta

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.scheduling.models import Event, EventInvitation, FinalMeeting, Participant
from apps.scheduling.services.invitations import create_or_reuse_managed_participant

FRONTEND = "https://app.releviz.test"


@override_settings(FRONTEND_URL=FRONTEND, DEFAULT_FROM_EMAIL="noreply@releviz.test")
class DeliveryRetryPreviewTests(TestCase):
    maxDiff = None

    def setUp(self):
        self.organizer = create_member("retry-preview-owner@example.com", "Olive", "Owner")
        self.outsider = create_member("retry-preview-outsider@example.com", "Other", "Person")
        self.client = APIClient()
        self.authenticate(self.organizer)
        self.event = Event.objects.create(
            code="RETRYPV1",
            name="Retry day",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        self.people = {
            name: create_or_reuse_managed_participant(
                event=self.event,
                organizer=self.organizer,
                name=f"{name} Person",
                email=f"{name.lower()}@example.com",
            )["participant"]
            for name in ("Zoe", "Ada", "Bob")
        }

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def invite_everyone(self):
        response = self.client.post(
            f"/events/roster/invitations?code={self.event.code}",
            {"filter": {"all": True}, "idempotencyKey": str(uuid.uuid4())},
            format="json",
        )
        self.assertEqual(response.status_code, 202, response.data)
        return EmailDeliveryRequest.objects.get(pk=response.data["deliveryRequest"]["id"])

    def retry(self, delivery_request, payload):
        return self.client.post(
            f"/events/delivery-requests/{delivery_request.pk}", payload, format="json"
        )

    def jobs_state(self, delivery_request):
        return list(
            delivery_request.jobs.order_by("pk").values_list(
                "pk", "status", "attempt_count", "last_error", "updated_at"
            )
        )

    def test_preview_counts_what_a_retry_would_do_and_shows_the_first_resend(self):
        delivery_request = self.invite_everyone()
        # Zoe's email failed but she has since left the roster; Ada's and
        # Bob's failed while they are still on it. Retries go in queue order.
        delivery_request.jobs.update(
            status=EmailDeliveryJob.Status.PERMANENT_FAILURE, last_error="rejected"
        )
        Participant.objects.filter(pk=self.people["Zoe"].pk).update(hidden=True)
        jobs = list(delivery_request.jobs.order_by("pk"))
        first_eligible = next(job for job in jobs if job.recipient != "zoe@example.com")
        invitation = first_eligible.invitation
        state = self.jobs_state(delivery_request)
        request_updated = EmailDeliveryRequest.objects.get(pk=delivery_request.pk).updated_at

        preview = self.retry(delivery_request, {"preview": True})

        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertIn("no-store", preview["Cache-Control"])
        self.assertEqual(self.jobs_state(delivery_request), state)
        self.assertEqual(
            EmailDeliveryRequest.objects.get(pk=delivery_request.pk).updated_at, request_updated
        )
        self.assertTrue(preview.data["preview"])
        self.assertEqual(preview.data["retryable"], 2)
        self.assertEqual(preview.data["obsolete"], 1)
        name = Participant.objects.get(member=invitation.member).participant_name
        self.assertEqual(preview.data["sample"], {"name": name, "email": invitation.email})
        email = preview.data["email"]
        self.assertEqual(email["to"], f"{name} <{invitation.email}>")
        self.assertEqual(email["subject"], first_eligible.subject)
        # The stored email, with the recipient's private link swapped out.
        token = str(invitation.access_token)
        self.assertIn(token, first_eligible.body)
        self.assertEqual(email["text"], first_eligible.body.replace(token, "preview"))
        self.assertEqual(email["html"], first_eligible.html_body.replace(token, "preview"))
        self.assertIn("invitation=preview", email["text"])
        self.assertNotIn(token, email["html"])

        retried = self.retry(delivery_request, {})
        self.assertEqual(retried.status_code, 202, retried.data)
        self.assertEqual(retried.data["retried"], preview.data["retryable"])
        self.assertEqual(retried.data["canceled"], preview.data["obsolete"])

        # Nothing failed is left, so there is nothing to preview.
        empty = self.retry(delivery_request, {"preview": True})
        self.assertEqual(
            empty.data,
            {"preview": True, "retryable": 0, "obsolete": 0, "email": None, "sample": None},
        )

    def test_preview_of_a_request_that_is_no_longer_current(self):
        delivery_request = self.invite_everyone()
        delivery_request.jobs.update(status=EmailDeliveryJob.Status.PERMANENT_FAILURE)
        self.event.status = Event.Status.CLOSED
        self.event.save(update_fields=["status", "updated_at"])

        preview = self.retry(delivery_request, {"preview": True})

        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual(preview.data["retryable"], 0)
        self.assertEqual(preview.data["obsolete"], 3)
        self.assertIsNone(preview.data["email"])
        self.assertEqual(
            delivery_request.jobs.filter(status=EmailDeliveryJob.Status.PERMANENT_FAILURE).count(),
            3,
        )

    def test_final_confirmation_retry_preview_needs_no_redaction(self):
        now = timezone.now()
        meeting = FinalMeeting.objects.create(
            event=self.event,
            starts_at=now,
            ends_at=now + timedelta(minutes=30),
            timezone="UTC",
            channel="virtual",
            location="Online",
            calendar_uid=f"retry-preview-{self.event.event_id}@releviz",
            calendar_sequence=0,
            confirmed_by=self.organizer,
            confirmed_at=now,
        )
        ada = self.people["Ada"]
        EventInvitation.objects.filter(member=ada.member).update(first_sent_at=now)
        job = EmailDeliveryJob.objects.create(
            idempotency_key=f"final-confirmation:{self.event.event_id}:{meeting.calendar_sequence}:a",
            message_type=EmailMessageLog.MessageType.FINAL_CONFIRMATION,
            recipient="ada@example.com",
            subject="Confirmed: Retry day",
            body="Confirmed text",
            html_body="<p>Confirmed</p>",
            attachments=[{"filename": "final.ics", "content": "x", "mimetype": "text/calendar"}],
            message_id="<final-retry@releviz.local>",
            event=self.event,
            status=EmailDeliveryJob.Status.PERMANENT_FAILURE,
        )
        delivery_request = EmailDeliveryRequest.objects.create(
            event=self.event,
            requested_by=self.organizer,
            operation=EmailDeliveryRequest.Operation.FINAL_CONFIRMATION,
            idempotency_key=uuid.uuid4(),
            request_fingerprint="f" * 64,
            recipient_count=1,
            created_job_count=1,
        )
        delivery_request.jobs.add(job)

        preview = self.retry(delivery_request, {"preview": True})

        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual(preview.data["retryable"], 1)
        self.assertEqual(preview.data["sample"], {"name": "Ada Person", "email": "ada@example.com"})
        self.assertEqual(
            preview.data["email"],
            {
                "from": "noreply@releviz.test",
                "replyTo": "",
                "to": "Ada Person <ada@example.com>",
                "subject": "Confirmed: Retry day",
                "html": "<p>Confirmed</p>",
                "text": "Confirmed text",
                "attachments": ["final.ics"],
            },
        )

    def test_preview_flag_must_be_a_boolean_and_stays_private(self):
        delivery_request = self.invite_everyone()
        invalid = self.retry(delivery_request, {"preview": "yes"})
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.data["error"], "preview must be a boolean.")

        self.authenticate(self.outsider)
        hidden = self.retry(delivery_request, {"preview": True})
        self.assertEqual(hidden.status_code, 404)
