import json
from datetime import UTC, datetime, timedelta
from io import StringIO

from django.core.management import CommandError, call_command
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import AuthRateLimitBucket
from apps.authn.tests.helpers import create_member, token_for
from apps.core.analytics import (
    _median_duration,
    _rate,
    build_product_metrics,
    prometheus_product_metrics,
)
from apps.core.models import FeedbackSubmission
from apps.core.retention import prune_feedback_submissions
from apps.messaging.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.models import Event, EventInvitation, FinalMeeting, Participant


class FeedbackApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_anonymous_and_authenticated_feedback_is_persisted_without_url_secrets(self):
        with self.assertLogs("apps.core.views", level="INFO") as logs:
            response = self.client.post(
                "/feedback",
                {
                    "category": "problem",
                    "message": "The final action was unclear.",
                    "pagePath": "/event?code=SECRET#availability",
                    "consentToFollowUp": True,
                },
                format="json",
            )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["status"], "received")
        self.assertIn("no-store", response["Cache-Control"])
        feedback = FeedbackSubmission.objects.get(pk=response.data["id"])
        self.assertIsNone(feedback.member)
        self.assertEqual(feedback.page_path, "/event")
        self.assertTrue(feedback.consent_to_follow_up)
        self.assertIsNotNone(feedback.request_id)
        self.assertEqual(str(feedback), "Problem feedback [new]")
        self.assertNotIn(feedback.message, logs.output[0])

        member = create_member("feedback-member@example.com")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")
        authenticated = self.client.post(
            "/feedback",
            {
                "category": "idea",
                "message": "Add a compact result view.",
            },
            format="json",
        )
        self.assertEqual(authenticated.status_code, 201)
        linked = FeedbackSubmission.objects.get(pk=authenticated.data["id"])
        self.assertEqual(linked.member, member)
        self.assertEqual(linked.page_path, "")
        self.assertFalse(linked.consent_to_follow_up)

    def test_feedback_input_is_bounded_and_rate_limited(self):
        invalid_payloads = [
            {"category": "unknown", "message": "A valid message"},
            {"category": "problem", "message": "x"},
            {
                "category": "problem",
                "message": "A valid message",
                "pagePath": "https://example.com/private",
            },
            {
                "category": "problem",
                "message": "A valid message",
                "pagePath": "/" + ("a" * 500),
            },
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                response = self.client.post("/feedback", payload, format="json")
                self.assertEqual(response.status_code, 400)
        self.assertEqual(FeedbackSubmission.objects.count(), 0)
        AuthRateLimitBucket.objects.all().delete()

        limits = {
            "feedback": {
                "ip": {"limit": 1, "window": 60, "block": 60},
            }
        }
        with override_settings(AUTH_RATE_LIMITS=limits):
            accepted = self.client.post(
                "/feedback",
                {"category": "other", "message": "First report"},
                format="json",
            )
            blocked = self.client.post(
                "/feedback",
                {"category": "other", "message": "Second report"},
                format="json",
            )
        self.assertEqual(accepted.status_code, 201)
        self.assertEqual(blocked.status_code, 429)

    def test_metrics_endpoint_requires_its_dedicated_bearer_token(self):
        with override_settings(METRICS_BEARER_TOKEN=""):
            unavailable = self.client.get("/metrics")
        self.assertEqual(unavailable.status_code, 503)

        with override_settings(METRICS_BEARER_TOKEN="metrics-secret"):
            missing = self.client.get("/metrics")
            wrong = self.client.get(
                "/metrics",
                HTTP_AUTHORIZATION="Bearer wrong",
            )
            accepted = self.client.get(
                "/metrics",
                HTTP_AUTHORIZATION="Bearer metrics-secret",
            )
        self.assertEqual(missing.status_code, 401)
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(accepted.status_code, 200)
        self.assertIn("text/plain", accepted["Content-Type"])
        self.assertIn("no-store", accepted["Cache-Control"])
        self.assertIn("releviz_events_created 0", accepted.content.decode())

    @override_settings(FEEDBACK_SUBMISSION_RETENTION=timedelta(days=730))
    def test_feedback_retention_deletes_only_records_older_than_the_policy(self):
        as_of = datetime(2026, 7, 16, 12, tzinfo=UTC)
        expired = FeedbackSubmission.objects.create(
            category=FeedbackSubmission.Category.PROBLEM,
            message="Expired feedback",
        )
        boundary = FeedbackSubmission.objects.create(
            category=FeedbackSubmission.Category.IDEA,
            message="Boundary feedback",
        )
        current = FeedbackSubmission.objects.create(
            category=FeedbackSubmission.Category.USABILITY,
            message="Current feedback",
        )
        FeedbackSubmission.objects.filter(pk=expired.pk).update(
            created_at=as_of - timedelta(days=731)
        )
        FeedbackSubmission.objects.filter(pk=boundary.pk).update(
            created_at=as_of - timedelta(days=730)
        )
        FeedbackSubmission.objects.filter(pk=current.pk).update(
            created_at=as_of - timedelta(days=10)
        )

        self.assertEqual(prune_feedback_submissions(as_of=as_of), 1)
        self.assertEqual(
            set(FeedbackSubmission.objects.values_list("message", flat=True)),
            {"Boundary feedback", "Current feedback"},
        )


class ProductAnalyticsTests(TestCase):
    as_of = datetime(2026, 7, 16, 12, tzinfo=UTC)

    def setUp(self):
        self.organizer = create_member("analytics-organizer@example.com")
        self.event = self._event(
            self.organizer,
            "ANALYTICS1",
            self.as_of - timedelta(days=10),
        )
        self.closed_event = self._event(
            self.organizer,
            "ANALYTICS2",
            self.as_of - timedelta(days=5),
        )
        self.future_state_event = self._event(
            self.organizer,
            "ANALYTICS3",
            self.as_of - timedelta(days=2),
        )
        Event.objects.filter(pk=self.closed_event.pk).update(
            closed_at=self.as_of - timedelta(days=1)
        )
        Event.objects.filter(pk=self.future_state_event.pk).update(
            closed_at=self.as_of + timedelta(days=1)
        )

        first = self._participant(
            "analytics-first@example.com",
            self.as_of - timedelta(days=9),
            first_submitted_at=self.as_of - timedelta(days=7),
            submitted=True,
        )
        second = self._participant(
            "analytics-second@example.com",
            self.as_of - timedelta(days=8),
            first_submitted_at=self.as_of - timedelta(days=7),
            submitted=True,
        )
        future_submission = self._participant(
            "analytics-draft@example.com",
            self.as_of - timedelta(days=6),
            first_draft_saved_at=self.as_of - timedelta(days=5),
            first_submitted_at=self.as_of + timedelta(days=1),
        )
        self.assertFalse(future_submission.submitted)
        self._participant(
            "closed-first@example.com",
            self.as_of + timedelta(seconds=1),
            first_submitted_at=self.as_of - timedelta(days=1),
            submitted=True,
            event=self.closed_event,
        )
        self._participant(
            "closed-second@example.com",
            self.as_of + timedelta(seconds=1),
            first_submitted_at=self.as_of - timedelta(days=1),
            submitted=True,
            event=self.closed_event,
        )
        self.assertTrue(first.submitted and second.submitted)

        FinalMeeting.objects.create(
            event=self.event,
            starts_at=self.as_of + timedelta(days=1),
            ends_at=self.as_of + timedelta(days=1, hours=1),
            timezone="UTC",
            channel="virtual",
            calendar_uid="analytics-final@releviz.local",
            attendance_snapshot={},
            confirmed_by=self.organizer,
            confirmed_at=self.as_of - timedelta(days=1),
        )
        FinalMeeting.objects.create(
            event=self.closed_event,
            starts_at=self.as_of + timedelta(days=2),
            ends_at=self.as_of + timedelta(days=2, hours=1),
            timezone="UTC",
            channel="virtual",
            calendar_uid="analytics-future-final@releviz.local",
            attendance_snapshot={},
            confirmed_by=self.organizer,
            confirmed_at=self.as_of + timedelta(days=1),
        )
        invitation_values = [
            {
                "email": "submitted@example.com",
                "opened_at": self.as_of - timedelta(days=8, hours=12),
                "joined_at": self.as_of - timedelta(days=8),
                "draft_saved_at": self.as_of - timedelta(days=7, hours=12),
                "submitted_at": self.as_of - timedelta(days=7),
                "status": EventInvitation.Status.SUBMITTED,
            },
            {
                "email": "opened@example.com",
                "opened_at": self.as_of - timedelta(days=8),
                "status": EventInvitation.Status.OPENED,
            },
            {
                "email": "joined@example.com",
                "opened_at": self.as_of + timedelta(days=1),
                "joined_at": self.as_of - timedelta(days=8),
                "status": EventInvitation.Status.JOINED,
            },
            {
                "email": "draft@example.com",
                "joined_at": self.as_of - timedelta(days=8),
                "draft_saved_at": self.as_of - timedelta(days=7),
                "submitted_at": self.as_of + timedelta(days=1),
                "status": EventInvitation.Status.DRAFT_SAVED,
            },
        ]
        for index, values in enumerate(invitation_values):
            EventInvitation.objects.create(
                event=self.event,
                invited_by=self.organizer,
                first_sent_at=self.as_of - timedelta(days=9, hours=-index),
                last_sent_at=self.as_of - timedelta(days=9, hours=-index),
                **values,
            )
        EventInvitation.objects.create(
            event=self.future_state_event,
            email="future@example.com",
            invited_by=self.organizer,
            first_sent_at=self.as_of + timedelta(days=1),
            last_sent_at=self.as_of + timedelta(days=1),
            opened_at=self.as_of + timedelta(days=1),
            joined_at=self.as_of + timedelta(days=1),
            draft_saved_at=self.as_of + timedelta(days=1),
            submitted_at=self.as_of + timedelta(days=1),
            status=EventInvitation.Status.SUBMITTED,
        )

        self._email_job("analytics-retried", attempt_count=2, status=EmailDeliveryJob.Status.SENT)
        self._email_job(
            "analytics-failed",
            attempt_count=1,
            status=EmailDeliveryJob.Status.PERMANENT_FAILURE,
        )
        FeedbackSubmission.objects.create(
            category=FeedbackSubmission.Category.PROBLEM,
            message="Anonymous product feedback",
        )
        FeedbackSubmission.objects.create(
            category=FeedbackSubmission.Category.IDEA,
            message="Member product feedback",
            member=self.organizer,
        )
        FeedbackSubmission.objects.filter(
            message__in=["Anonymous product feedback", "Member product feedback"]
        ).update(
            created_at=self.as_of - timedelta(days=3),
            updated_at=self.as_of - timedelta(days=3),
        )

        repeat_organizer = create_member("repeat-organizer@example.com")
        self._event(repeat_organizer, "REPEAT01", self.as_of - timedelta(days=100))
        self._event(repeat_organizer, "REPEAT02", self.as_of - timedelta(days=70))
        nonrepeat_organizer = create_member("nonrepeat-organizer@example.com")
        self._event(nonrepeat_organizer, "NOREPEAT1", self.as_of - timedelta(days=100))
        self._event(nonrepeat_organizer, "NOREPEAT2", self.as_of - timedelta(days=35))

        staff = create_member("analytics-staff@example.com", is_staff=True)
        self._event(staff, "STAFFEVT", self.as_of - timedelta(days=2))
        FeedbackSubmission.objects.create(
            category=FeedbackSubmission.Category.OTHER,
            message="Internal feedback",
            member=staff,
        )
        FeedbackSubmission.objects.filter(message="Internal feedback").update(
            created_at=self.as_of - timedelta(days=3),
            updated_at=self.as_of - timedelta(days=3),
        )
        staff_job = self._email_job(
            "analytics-staff-job",
            attempt_count=3,
            status=EmailDeliveryJob.Status.PERMANENT_FAILURE,
            event=Event.objects.get(code="STAFFEVT"),
        )
        self.assertEqual(staff_job.attempt_count, 3)

    def _event(self, organizer, code, created_at):
        event = Event.objects.create(
            code=code,
            name=code,
            organizer=organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        Event.objects.filter(pk=event.pk).update(created_at=created_at, updated_at=created_at)
        event.refresh_from_db()
        return event

    def _participant(
        self,
        email,
        created_at,
        *,
        first_draft_saved_at=None,
        first_submitted_at=None,
        submitted=False,
        event=None,
    ):
        member = create_member(email)
        participant = Participant.objects.create(
            event=event or self.event,
            member=member,
            participant_name=member.display_name(),
            availability_inperson=[1, 1],
            availability_virtual=[1, 1],
            submitted=submitted,
            first_draft_saved_at=first_draft_saved_at,
            first_submitted_at=first_submitted_at,
            last_submitted_at=first_submitted_at,
        )
        Participant.objects.filter(pk=participant.pk).update(
            created_at=created_at,
            updated_at=created_at,
        )
        participant.refresh_from_db()
        return participant

    def _email_job(self, key, *, attempt_count, status, event=None):
        job = EmailDeliveryJob.objects.create(
            idempotency_key=key,
            message_type=EmailMessageLog.MessageType.INVITATION,
            recipient=f"{key}@example.com",
            subject="Subject",
            body="Body",
            message_id=f"<{key}@releviz.local>",
            event=event or self.event,
            attempt_count=attempt_count,
            status=status,
        )
        EmailDeliveryJob.objects.filter(pk=job.pk).update(
            created_at=self.as_of - timedelta(days=4),
            updated_at=self.as_of - timedelta(days=4),
        )
        job.refresh_from_db()
        return job

    def test_metrics_use_authoritative_cohorts_and_timestamps(self):
        metrics = build_product_metrics(as_of=self.as_of, window_days=30)
        self.assertEqual(metrics["schemaVersion"], 1)
        self.assertEqual(metrics["events"]["created"], 3)
        self.assertEqual(
            metrics["events"]["invitationActivation"],
            {"numerator": 1, "denominator": 3, "value": 0.3333},
        )
        self.assertEqual(metrics["events"]["eligibleForFinalization"], 2)
        self.assertEqual(metrics["events"]["finalization"]["value"], 0.5)
        self.assertEqual(metrics["events"]["closure"]["value"], 0.3333)
        self.assertEqual(
            metrics["events"]["creationToFirstInvitation"],
            {"sampleSize": 1, "medianSeconds": 86400.0},
        )
        self.assertEqual(metrics["events"]["withoutInvitation"], 2)

        self.assertEqual(metrics["invitations"]["sent"], 4)
        self.assertEqual(metrics["invitations"]["opened"], 2)
        self.assertEqual(metrics["invitations"]["joined"], 3)
        self.assertEqual(metrics["invitations"]["draftSaved"], 2)
        self.assertEqual(metrics["invitations"]["validSubmission"], 1)
        self.assertEqual(metrics["invitations"]["submissionConversion"]["value"], 0.25)
        self.assertEqual(metrics["invitations"]["openedNotJoined"], 1)
        self.assertEqual(metrics["invitations"]["joinedNotDraftSaved"], 1)
        self.assertEqual(metrics["invitations"]["draftSavedNotSubmitted"], 1)
        self.assertEqual(
            metrics["invitations"]["joinToSubmission"],
            {"sampleSize": 1, "medianSeconds": 86400.0},
        )

        self.assertEqual(metrics["participants"]["joined"], 3)
        self.assertEqual(metrics["participants"]["validSubmission"], 2)
        self.assertEqual(metrics["participants"]["draftSavedNotSubmitted"], 1)
        self.assertEqual(
            metrics["participants"]["completion"],
            {"sampleSize": 2, "medianSeconds": 129600.0},
        )
        self.assertEqual(metrics["organizers"]["repeatCreationWithin60Days"]["value"], 0.5)
        self.assertEqual(metrics["delivery"]["jobs"], 2)
        self.assertEqual(metrics["delivery"]["attempted"], 2)
        self.assertEqual(metrics["delivery"]["retried"], 1)
        self.assertEqual(metrics["delivery"]["retryRate"]["value"], 0.5)
        self.assertEqual(metrics["delivery"]["permanentFailures"], 1)
        self.assertEqual(metrics["feedback"]["submitted"], 2)

    def test_metrics_helpers_and_management_command_handle_empty_or_invalid_inputs(self):
        self.assertEqual(_rate(0, 0), {"numerator": 0, "denominator": 0, "value": None})
        self.assertEqual(
            _median_duration(
                [
                    (None, self.as_of),
                    (self.as_of, None),
                    (self.as_of, self.as_of - timedelta(seconds=1)),
                ]
            ),
            {"sampleSize": 0, "medianSeconds": None},
        )
        empty_metrics = build_product_metrics(
            as_of=datetime(2020, 1, 1, tzinfo=UTC),
            window_days=1,
        )
        prometheus = prometheus_product_metrics(empty_metrics)
        self.assertIn("releviz_event_invitation_activation_ratio NaN", prometheus)
        self.assertIn("# TYPE releviz_feedback_submissions gauge", prometheus)

        output = StringIO()
        call_command(
            "product_metrics",
            "--days=30",
            "--as-of=2026-07-16T12:00:00+00:00",
            stdout=output,
        )
        command_metrics = json.loads(output.getvalue())
        self.assertEqual(command_metrics["events"]["created"], 3)

        default_output = StringIO()
        call_command("product_metrics", "--days=1", stdout=default_output)
        self.assertEqual(json.loads(default_output.getvalue())["period"]["windowDays"], 1)

        with self.assertRaises(CommandError):
            call_command("product_metrics", "--days=0")
        with self.assertRaises(CommandError):
            call_command("product_metrics", "--as-of=not-a-timestamp")
        with self.assertRaises(CommandError):
            call_command("product_metrics", "--as-of=2026-07-16T12:00:00")

    def test_default_as_of_is_timezone_aware(self):
        before = timezone.now()
        metrics = build_product_metrics(window_days=1)
        generated_at = datetime.fromisoformat(metrics["generatedAt"])
        self.assertGreaterEqual(generated_at, before)
        self.assertIsNotNone(generated_at.tzinfo)
