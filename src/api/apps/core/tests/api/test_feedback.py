"""Tests for the in-product feedback endpoint."""

from django.test import TestCase
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.core.models import FeedbackSubmission


class FeedbackApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_anonymous_feedback_is_stored_without_url_secrets(self):
        with self.assertLogs("apps.core.views.feedback", level="INFO") as logs:
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
        # Only the path survives, so codes and fragments cannot leak.
        self.assertEqual(feedback.page_path, "/event")
        self.assertTrue(feedback.consent_to_follow_up)
        self.assertEqual(feedback.status, FeedbackSubmission.Status.NEW)
        self.assertEqual(str(feedback), "Problem feedback [new]")
        self.assertNotIn(feedback.message, logs.output[0])

    def test_authenticated_feedback_is_attributed_to_the_member(self):
        member = create_member("feedback-member@example.com")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

        response = self.client.post(
            "/feedback",
            {"category": "idea", "message": "Add a compact result view."},
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        feedback = FeedbackSubmission.objects.get(pk=response.data["id"])
        self.assertEqual(feedback.member, member)
        self.assertEqual(feedback.page_path, "")
        self.assertFalse(feedback.consent_to_follow_up)

    def test_request_id_is_recorded_when_the_middleware_supplies_one(self):
        response = self.client.post(
            "/feedback",
            {"category": "other", "message": "Recorded with a request id."},
            format="json",
        )

        feedback = FeedbackSubmission.objects.get(pk=response.data["id"])
        self.assertIsNotNone(feedback.request_id)

    def test_invalid_submissions_are_rejected(self):
        for payload in (
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
        ):
            with self.subTest(payload=payload):
                response = self.client.post("/feedback", payload, format="json")
                self.assertEqual(response.status_code, 400)

        self.assertEqual(FeedbackSubmission.objects.count(), 0)

    def test_blank_page_path_is_normalized_to_empty(self):
        response = self.client.post(
            "/feedback",
            {"category": "usability", "message": "No path supplied.", "pagePath": ""},
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(FeedbackSubmission.objects.get(pk=response.data["id"]).page_path, "")

    def test_authenticated_rate_identity_is_the_member_id(self):
        from apps.core.views import FeedbackView

        member = create_member("rate-identity@example.com")
        view = FeedbackView()

        class _Request:
            def __init__(self, user):
                self.user = user

        self.assertEqual(view.get_auth_rate_identity(_Request(member)), str(member.pk))

        class _Anonymous:
            is_authenticated = False

        self.assertEqual(view.get_auth_rate_identity(_Request(_Anonymous())), "")
