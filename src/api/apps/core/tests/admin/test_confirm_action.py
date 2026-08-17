"""Integration tests for typed confirmation on current admin bulk actions."""

from django.contrib.admin import helpers
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.authn.models import AdminInvitation
from apps.core.models import BackgroundJob
from apps.core.services.background_jobs import enqueue_job
from apps.core.tests.helpers import make_superuser

JOB_ACTION_SESSION_KEY = "_admin_pending_action_core_backgroundjob"
INVITATION_ACTION_SESSION_KEY = "_admin_pending_action_authn_admininvitation"


def _failed_job(key: str) -> BackgroundJob:
    job, _created = enqueue_job(kind="test.echo", dedupe_key=key, payload={})
    BackgroundJob.objects.filter(pk=job.pk).update(status=BackgroundJob.Status.FAILED)
    job.refresh_from_db()
    return job


def _confirm_data(client, session_key, confirmation_word, *, token=None):
    return {
        "confirmation_word": confirmation_word,
        "token": token or client.session[session_key]["token"],
    }


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmBackgroundJobActionTests(TestCase):
    def setUp(self):
        make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def _action_post(self, jobs, *, select_across="0", query=""):
        return self.client.post(
            reverse("admin:core_backgroundjob_changelist") + query,
            {
                "action": "retry_selected_jobs",
                "index": "0",
                "select_across": select_across,
                helpers.ACTION_CHECKBOX_NAME: [str(job.pk) for job in jobs],
            },
        )

    def test_mutating_action_redirects_to_confirmation_page(self):
        response = self._action_post([_failed_job("redirect")])

        self.assertEqual(response.status_code, 302)
        self.assertIn("confirm-action", response.url)
        self.assertIn(JOB_ACTION_SESSION_KEY, self.client.session)

    def test_confirmation_page_shows_current_action_description_and_count(self):
        self._action_post([_failed_job("one"), _failed_job("two")])

        response = self.client.get(reverse("admin:core_backgroundjob_confirm_action"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Explicitly retry selected failed/uncertain jobs")
        self.assertContains(response, "2")
        self.assertContains(response, "confirm-input")

    def test_wrong_confirmation_word_does_not_execute(self):
        job = _failed_job("wrong")
        self._action_post([job])

        response = self.client.post(
            reverse("admin:core_backgroundjob_confirm_action"),
            _confirm_data(self.client, JOB_ACTION_SESSION_KEY, "wrong word"),
            follow=True,
        )

        self.assertContains(response, "Please type")
        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.FAILED)

    def test_correct_confirmation_word_executes_case_insensitively(self):
        for index, word in enumerate(("background job", "Background Job")):
            with self.subTest(word=word):
                job = _failed_job(f"correct-{index}")
                self._action_post([job])
                response = self.client.post(
                    reverse("admin:core_backgroundjob_confirm_action"),
                    _confirm_data(self.client, JOB_ACTION_SESSION_KEY, word),
                )
                self.assertEqual(response.status_code, 302)
                job.refresh_from_db()
                self.assertEqual(job.status, BackgroundJob.Status.RETRY)

    def test_no_pending_and_invalid_token_are_rejected(self):
        confirm_url = reverse("admin:core_backgroundjob_confirm_action")
        response = self.client.get(confirm_url, follow=True)
        self.assertContains(response, "No pending action found")

        job = _failed_job("bad-token")
        self._action_post([job])
        response = self.client.post(
            confirm_url,
            _confirm_data(
                self.client,
                JOB_ACTION_SESSION_KEY,
                "background job",
                token="not-the-session-token",
            ),
            follow=True,
        )
        self.assertContains(response, "Invalid confirmation token")
        self.assertNotIn(JOB_ACTION_SESSION_KEY, self.client.session)

    def test_cancel_link_and_select_across_preserve_filtered_scope(self):
        included = _failed_job("included")
        excluded, _created = enqueue_job(kind="test.echo", dedupe_key="excluded", payload={})
        self._action_post(
            [included],
            select_across="1",
            query=f"?status__exact={BackgroundJob.Status.FAILED}",
        )

        confirm_url = reverse("admin:core_backgroundjob_confirm_action")
        response = self.client.get(confirm_url)
        self.assertContains(response, reverse("admin:core_backgroundjob_changelist"))
        self.assertContains(response, "1")
        self.client.post(
            confirm_url,
            _confirm_data(self.client, JOB_ACTION_SESSION_KEY, "background job"),
        )

        included.refresh_from_db()
        excluded.refresh_from_db()
        self.assertEqual(included.status, BackgroundJob.Status.RETRY)
        self.assertEqual(excluded.status, BackgroundJob.Status.PENDING)


@override_settings(ADMIN_REQUIRE_CONFIRMATION=False)
class ConfirmActionDisabledTests(TestCase):
    def setUp(self):
        make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def test_action_executes_immediately_when_disabled(self):
        job = _failed_job("disabled")
        response = self.client.post(
            reverse("admin:core_backgroundjob_changelist"),
            {
                "action": "retry_selected_jobs",
                "index": "0",
                "select_across": "0",
                helpers.ACTION_CHECKBOX_NAME: [str(job.pk)],
            },
        )

        self.assertEqual(response.status_code, 302)
        self.assertNotIn("confirm-action", response.url)
        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.RETRY)


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmActionExemptionAndDeleteTests(TestCase):
    def setUp(self):
        make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def test_export_action_bypasses_confirmation(self):
        job = _failed_job("export")
        response = self.client.post(
            reverse("admin:core_backgroundjob_changelist"),
            {
                "action": "export_data",
                "index": "0",
                "select_across": "0",
                helpers.ACTION_CHECKBOX_NAME: [str(job.pk)],
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("confirm-action", response.get("Location", ""))

    def test_delete_selected_requires_and_honors_confirmation(self):
        invitation = AdminInvitation.objects.create(
            email="delete@example.com",
            token=AdminInvitation.generate_token(),
            expires_at=timezone.now() + timezone.timedelta(days=1),
        )
        changelist = reverse("admin:authn_admininvitation_changelist")
        response = self.client.post(
            changelist,
            {
                "action": "delete_selected",
                "index": "0",
                "select_across": "0",
                helpers.ACTION_CHECKBOX_NAME: [str(invitation.pk)],
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assertIn("confirm-action", response.url)

        confirm_url = reverse("admin:authn_admininvitation_confirm_action")
        response = self.client.get(confirm_url)
        self.assertContains(response, "Delete selected Admin Invitations")
        self.client.post(
            confirm_url,
            _confirm_data(
                self.client,
                INVITATION_ACTION_SESSION_KEY,
                "Admin Invitation",
            ),
        )

        self.assertFalse(AdminInvitation.objects.filter(pk=invitation.pk).exists())
