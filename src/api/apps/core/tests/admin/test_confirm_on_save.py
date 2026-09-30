"""Integration tests for typed confirmation on current admin forms."""

from django.contrib import admin
from django.contrib.admin import helpers
from django.core.exceptions import PermissionDenied
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse

from apps.core.models import AWSCredentialConfig, BackgroundJob
from apps.core.services.background_jobs import enqueue_job
from apps.core.tests.helpers import make_admin, make_superuser

CHANGE_SESSION_KEY = "_admin_pending_change_core_awscredentialconfig"
ADD_URL = "admin:core_awscredentialconfig_add"
CONFIRM_URL = "admin:core_awscredentialconfig_confirm_change"


def _form_data(name: str, *, active=False):
    return {
        "name": name,
        "is_active": "on" if active else "",
        "access_key_id": "",
        "default_region": "us-west-2",
        "secret_access_key": "",
    }


def _confirm_change_data(client, confirmation_word, *, token=None):
    return {
        "confirmation_word": confirmation_word,
        "token": token or client.session[CHANGE_SESSION_KEY]["token"],
    }


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmViewAdminAccessTests(TestCase):
    def setUp(self):
        self.outsider = make_admin(
            apps=["scheduling"],
            email="outsider@example.com",
        )
        self.client.login(username="outsider@example.com", password="testpass123")

    def test_former_admin_cannot_access_confirmation_views(self):
        self.outsider.is_staff = False
        self.outsider.save(update_fields=["is_staff"])
        for url_name in (CONFIRM_URL, "admin:core_awscredentialconfig_confirm_action"):
            with self.subTest(url_name=url_name):
                response = self.client.get(reverse(url_name))
                self.assertEqual(response.status_code, 302)
                self.assertTrue(response.url.startswith(reverse("admin:login")))

    def test_admin_can_access_confirmation_for_any_app(self):
        response = self.client.get(reverse(CONFIRM_URL), follow=True)
        self.assertContains(response, "No pending change found")

    def test_change_confirmation_rechecks_demoted_admin_before_pending_save(self):
        response = self.client.post(reverse(ADD_URL), _form_data("Protected config"))
        self.assertEqual(response.status_code, 302)
        session = self.client.session
        pending = session[CHANGE_SESSION_KEY]
        model_admin = admin.site._registry[AWSCredentialConfig]

        self.outsider.is_staff = False
        self.outsider.save(update_fields=["is_staff"])
        request = RequestFactory().post(
            reverse(CONFIRM_URL),
            {
                "token": pending["token"],
                "confirmation_word": model_admin.get_confirmation_word(),
            },
        )
        request.user = self.outsider
        request.session = session

        with self.assertRaisesMessage(PermissionDenied, "You do not have permission to view"):
            model_admin._confirm_change_view(request)

        self.assertEqual(session[CHANGE_SESSION_KEY], pending)
        self.assertFalse(AWSCredentialConfig.objects.filter(name="Protected config").exists())

    def test_action_confirmation_rechecks_inactive_admin_before_pending_retry(self):
        job, _created = enqueue_job(kind="test.echo", dedupe_key="revoked-admin", payload={})
        job.status = BackgroundJob.Status.FAILED
        job.save(update_fields=["status"])
        model_admin = admin.site._registry[BackgroundJob]
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
        session = self.client.session
        session_key = model_admin._session_action_key()
        pending = session[session_key]

        self.outsider.is_active = False
        self.outsider.save(update_fields=["is_active"])
        request = RequestFactory().post(
            reverse("admin:core_backgroundjob_confirm_action"),
            {
                "token": pending["token"],
                "confirmation_word": model_admin.get_action_confirmation_word(
                    "retry_selected_jobs"
                ),
            },
        )
        request.user = self.outsider
        request.session = session

        with self.assertRaisesMessage(PermissionDenied, "You do not have permission to view"):
            model_admin._confirm_action_view(request)

        self.assertEqual(session[session_key], pending)
        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.FAILED)


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmOnSaveAddTests(TestCase):
    def setUp(self):
        make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def _submit(self, name):
        return self.client.post(reverse(ADD_URL), _form_data(name))

    def test_add_redirects_and_records_model_specific_pending_state(self):
        response = self._submit("Pending config")

        self.assertEqual(response.status_code, 302)
        self.assertIn("confirm-change", response.url)
        self.assertIn(CHANGE_SESSION_KEY, self.client.session)
        self.assertNotIn("_admin_pending_change", self.client.session)

    def test_confirmation_page_shows_values_and_requires_word(self):
        self._submit("New config")
        response = self.client.get(reverse(CONFIRM_URL))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Adding")
        self.assertContains(response, "New config")
        self.assertContains(response, 'Type <strong>"')
        self.assertContains(response, "confirm-input")

    def test_wrong_word_and_invalid_token_do_not_save(self):
        self._submit("Wrong word")
        response = self.client.post(
            reverse(CONFIRM_URL),
            _confirm_change_data(self.client, "WRONG"),
            follow=True,
        )
        self.assertContains(response, "Please type")
        self.assertFalse(AWSCredentialConfig.objects.filter(name="Wrong word").exists())

        self._submit("Bad token")
        response = self.client.post(
            reverse(CONFIRM_URL),
            _confirm_change_data(
                self.client,
                "AWS credential",
                token="not-the-session-token",
            ),
            follow=True,
        )
        self.assertContains(response, "Invalid confirmation token")
        self.assertFalse(AWSCredentialConfig.objects.filter(name="Bad token").exists())
        self.assertNotIn(CHANGE_SESSION_KEY, self.client.session)

    def test_correct_word_saves_case_insensitively(self):
        for index, word in enumerate(("AWS credential", "aws CREDENTIAL")):
            with self.subTest(word=word):
                name = f"Confirmed {index}"
                self._submit(name)
                self.client.post(
                    reverse(CONFIRM_URL),
                    _confirm_change_data(self.client, word),
                )
                self.assertTrue(AWSCredentialConfig.objects.filter(name=name).exists())


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmOnSaveChangeAndDeleteTests(TestCase):
    def setUp(self):
        make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")
        self.config = AWSCredentialConfig.objects.create(name="Original", is_active=False)

    def _change_url(self):
        return reverse("admin:core_awscredentialconfig_change", args=[self.config.pk])

    def _delete_url(self):
        return reverse("admin:core_awscredentialconfig_delete", args=[self.config.pk])

    def test_change_confirmation_shows_diff_and_updates(self):
        response = self.client.post(self._change_url(), _form_data("Changed"))
        self.assertEqual(response.status_code, 302)
        self.assertIn("confirm-change", response.url)

        response = self.client.get(reverse(CONFIRM_URL))
        self.assertContains(response, "Changing")
        self.assertContains(response, "Original")
        self.assertContains(response, "Changed")

        self.client.post(
            reverse(CONFIRM_URL),
            _confirm_change_data(self.client, "AWS credential"),
        )
        self.config.refresh_from_db()
        self.assertEqual(self.config.name, "Changed")

    def test_no_change_skips_confirmation(self):
        response = self.client.post(self._change_url(), _form_data("Original"))
        self.assertNotIn("confirm-change", response.url if response.status_code == 302 else "")

    def test_delete_confirmation_shows_details_and_removes_object(self):
        response = self.client.post(self._delete_url(), {"post": "yes"})
        self.assertEqual(response.status_code, 302)
        self.assertIn("confirm-change", response.url)

        response = self.client.get(reverse(CONFIRM_URL))
        self.assertContains(response, "Deleting")
        self.assertContains(response, "Original")

        self.client.post(
            reverse(CONFIRM_URL),
            _confirm_change_data(self.client, "AWS credential"),
        )
        self.assertFalse(AWSCredentialConfig.objects.filter(pk=self.config.pk).exists())

    def test_wrong_word_does_not_delete(self):
        self.client.post(self._delete_url(), {"post": "yes"})
        self.client.post(
            reverse(CONFIRM_URL),
            _confirm_change_data(self.client, "NOPE"),
            follow=True,
        )
        self.assertTrue(AWSCredentialConfig.objects.filter(pk=self.config.pk).exists())


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmOnSaveSkipAndValidationTests(TestCase):
    def setUp(self):
        make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def test_popup_mode_skips_confirmation(self):
        data = _form_data("Popup") | {"_popup": "1"}
        response = self.client.post(reverse(ADD_URL), data)
        self.assertNotIn("confirm-change", response.url if response.status_code == 302 else "")
        self.assertTrue(AWSCredentialConfig.objects.filter(name="Popup").exists())

    def test_no_pending_change_shows_error(self):
        response = self.client.get(reverse(CONFIRM_URL), follow=True)
        self.assertContains(response, "No pending change found")

    @override_settings(ADMIN_REQUIRE_CONFIRMATION=False)
    def test_disabled_setting_saves_directly(self):
        self.client.post(reverse(ADD_URL), _form_data("Direct"))
        self.assertTrue(AWSCredentialConfig.objects.filter(name="Direct").exists())

    def test_invalid_form_shows_errors_not_confirmation(self):
        response = self.client.post(reverse(ADD_URL), _form_data(""))
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("confirm-change", response.get("Location", ""))
