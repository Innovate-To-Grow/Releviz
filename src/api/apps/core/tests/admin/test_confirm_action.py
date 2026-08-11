"""Tests for typed confirmation on bulk admin actions."""

from unittest.mock import patch

from django.contrib.admin import helpers
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import reverse

from apps.authn.models import ContactEmail
from apps.projects.models import Semester

User = get_user_model()
ACTION_SESSION_KEY = "_admin_pending_action_projects_semester"


def _make_superuser(email="admin@example.com"):
    user = User.objects.create_superuser(password="testpass123", first_name="Admin", last_name="User")
    ContactEmail.objects.create(member=user, email_address=email, email_type="primary", verified=True)
    return user


def _make_staff(email="staff@example.com"):
    user = User.objects.create_user(password="testpass123", is_staff=True, first_name="Staff", last_name="Member")
    ContactEmail.objects.create(member=user, email_address=email, email_type="primary", verified=True)
    return user


def _make_semester(**kwargs):
    defaults = {"year": 2025, "season": 1, "is_published": False}
    defaults.update(kwargs)
    return Semester.objects.create(**defaults)


def _confirm_action_data(client, confirmation_word, *, token=None):
    return {
        "confirmation_word": confirmation_word,
        "token": token or client.session[ACTION_SESSION_KEY]["token"],
    }


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmActionTest(TestCase):
    def setUp(self):
        self.admin_user = _make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def _action_post(self, action_name, pks):
        url = reverse("admin:projects_semester_changelist")
        data = {
            "action": action_name,
            "index": "0",
            "select_across": "0",
            helpers.ACTION_CHECKBOX_NAME: [str(pk) for pk in pks],
        }
        return self.client.post(url, data)

    def test_mutating_action_redirects_to_confirmation_page(self):
        semester = _make_semester()
        response = self._action_post("publish_selected", [semester.pk])

        self.assertEqual(response.status_code, 302)
        self.assertIn("confirm-action", response.url)

    def test_pending_action_uses_model_specific_session_key(self):
        semester = _make_semester()
        self._action_post("publish_selected", [semester.pk])

        session = self.client.session
        self.assertIn(ACTION_SESSION_KEY, session)
        self.assertNotIn("_admin_pending_action", session)

    def test_confirmation_page_shows_action_description(self):
        semester = _make_semester()
        self._action_post("publish_selected", [semester.pk])

        confirm_url = reverse("admin:projects_semester_confirm_action")
        response = self.client.get(confirm_url)

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Publish selected semesters")
        self.assertContains(response, "1")
        self.assertContains(response, "confirm-input")
        self.assertContains(response, "confirm-send-btn")

    def test_wrong_confirmation_word_does_not_execute(self):
        semester = _make_semester()
        self._action_post("publish_selected", [semester.pk])

        confirm_url = reverse("admin:projects_semester_confirm_action")
        response = self.client.post(confirm_url, _confirm_action_data(self.client, "wrong word"), follow=True)

        self.assertContains(response, "Please type")
        semester.refresh_from_db()
        self.assertFalse(semester.is_published)

    def test_correct_confirmation_word_executes_action(self):
        semester = _make_semester()
        self._action_post("publish_selected", [semester.pk])

        confirm_url = reverse("admin:projects_semester_confirm_action")
        response = self.client.post(confirm_url, _confirm_action_data(self.client, "semester"))

        self.assertEqual(response.status_code, 302)
        semester.refresh_from_db()
        self.assertTrue(semester.is_published)

    def test_case_insensitive_confirmation(self):
        semester = _make_semester()
        self._action_post("publish_selected", [semester.pk])

        confirm_url = reverse("admin:projects_semester_confirm_action")
        response = self.client.post(confirm_url, _confirm_action_data(self.client, "Semester"))

        self.assertEqual(response.status_code, 302)
        semester.refresh_from_db()
        self.assertTrue(semester.is_published)

    def test_multiple_items_shown_in_count(self):
        s1 = _make_semester(year=2024, season=1)
        s2 = _make_semester(year=2023, season=1)
        self._action_post("publish_selected", [s1.pk, s2.pk])

        confirm_url = reverse("admin:projects_semester_confirm_action")
        response = self.client.get(confirm_url)

        self.assertContains(response, "2")

    @patch("apps.authn.services.email.send_email.senders.send_notification_email")
    def test_confirmed_action_does_not_notify_staff(self, mock_send):
        _make_staff(email="notify@example.com")
        semester = _make_semester()
        self._action_post("publish_selected", [semester.pk])

        confirm_url = reverse("admin:projects_semester_confirm_action")
        self.client.post(confirm_url, _confirm_action_data(self.client, "semester"))

        semester.refresh_from_db()
        self.assertTrue(semester.is_published)
        mock_send.assert_not_called()

    def test_no_pending_action_shows_error(self):
        confirm_url = reverse("admin:projects_semester_confirm_action")
        response = self.client.get(confirm_url, follow=True)

        self.assertContains(response, "No pending action found")

    def test_invalid_token_clears_pending_action(self):
        semester = _make_semester()
        self._action_post("publish_selected", [semester.pk])

        confirm_url = reverse("admin:projects_semester_confirm_action")
        response = self.client.post(
            confirm_url,
            _confirm_action_data(self.client, "semester", token="not-the-session-token"),
            follow=True,
        )

        self.assertContains(response, "Invalid confirmation token")
        self.assertNotIn(ACTION_SESSION_KEY, self.client.session)
        semester.refresh_from_db()
        self.assertFalse(semester.is_published)

    def test_cancel_link_goes_to_changelist(self):
        semester = _make_semester()
        self._action_post("publish_selected", [semester.pk])

        confirm_url = reverse("admin:projects_semester_confirm_action")
        response = self.client.get(confirm_url)

        changelist_url = reverse("admin:projects_semester_changelist")
        self.assertContains(response, changelist_url)


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmActionExemptTest(TestCase):
    def setUp(self):
        self.admin_user = _make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def test_export_action_bypasses_confirmation(self):
        semester = _make_semester()
        url = reverse("admin:projects_semester_changelist")
        data = {
            "action": "export_data",
            "index": "0",
            "select_across": "0",
            helpers.ACTION_CHECKBOX_NAME: [str(semester.pk)],
        }
        response = self.client.post(url, data)

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("confirm-action", response.get("Location", ""))


@override_settings(ADMIN_REQUIRE_CONFIRMATION=False)
class ConfirmActionDisabledTest(TestCase):
    def setUp(self):
        self.admin_user = _make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def test_action_executes_immediately_when_disabled(self):
        semester = _make_semester()
        url = reverse("admin:projects_semester_changelist")
        data = {
            "action": "publish_selected",
            "index": "0",
            "select_across": "0",
            helpers.ACTION_CHECKBOX_NAME: [str(semester.pk)],
        }
        response = self.client.post(url, data)

        self.assertEqual(response.status_code, 302)
        self.assertNotIn("confirm-action", response.url)
        semester.refresh_from_db()
        self.assertTrue(semester.is_published)


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmActionDeleteSelectedTest(TestCase):
    """Django's built-in delete_selected should also require typed confirmation."""

    def setUp(self):
        self.admin_user = _make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def test_delete_selected_redirects_to_confirmation(self):
        semester = _make_semester()
        url = reverse("admin:projects_semester_changelist")
        data = {
            "action": "delete_selected",
            "index": "0",
            "select_across": "0",
            helpers.ACTION_CHECKBOX_NAME: [str(semester.pk)],
        }
        response = self.client.post(url, data)

        self.assertEqual(response.status_code, 302)
        self.assertIn("confirm-action", response.url)

    def test_delete_selected_shows_resolved_model_name(self):
        semester = _make_semester()
        url = reverse("admin:projects_semester_changelist")
        data = {
            "action": "delete_selected",
            "index": "0",
            "select_across": "0",
            helpers.ACTION_CHECKBOX_NAME: [str(semester.pk)],
        }
        self.client.post(url, data)

        confirm_url = reverse("admin:projects_semester_confirm_action")
        response = self.client.get(confirm_url)

        self.assertContains(response, "Delete selected semesters")
        self.assertNotContains(response, "%(verbose_name_plural)s")

    def test_delete_selected_executes_after_confirmation(self):
        semester = _make_semester()
        url = reverse("admin:projects_semester_changelist")
        data = {
            "action": "delete_selected",
            "index": "0",
            "select_across": "0",
            helpers.ACTION_CHECKBOX_NAME: [str(semester.pk)],
        }
        self.client.post(url, data)

        confirm_url = reverse("admin:projects_semester_confirm_action")
        self.client.post(confirm_url, _confirm_action_data(self.client, "semester"))

        self.assertFalse(Semester.objects.filter(pk=semester.pk).exists())


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmActionSelectAcrossTest(TestCase):
    def setUp(self):
        self.admin_user = _make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def test_select_across_shows_total_count(self):
        _make_semester(year=2024, season=1)
        _make_semester(year=2023, season=1)
        _make_semester(year=2022, season=1)

        url = reverse("admin:projects_semester_changelist")
        data = {
            "action": "publish_selected",
            "index": "0",
            "select_across": "1",
            helpers.ACTION_CHECKBOX_NAME: [""],
        }
        response = self.client.post(url, data)

        self.assertEqual(response.status_code, 302)
        self.assertIn("confirm-action", response.url)

        confirm_url = reverse("admin:projects_semester_confirm_action")
        response = self.client.get(confirm_url)
        self.assertContains(response, "3")

    def test_select_across_executes_on_all(self):
        s1 = _make_semester(year=2024, season=1)
        s2 = _make_semester(year=2023, season=1)

        url = reverse("admin:projects_semester_changelist")
        data = {
            "action": "publish_selected",
            "index": "0",
            "select_across": "1",
            helpers.ACTION_CHECKBOX_NAME: [""],
        }
        self.client.post(url, data)

        confirm_url = reverse("admin:projects_semester_confirm_action")
        self.client.post(confirm_url, _confirm_action_data(self.client, "semester"))

        s1.refresh_from_db()
        s2.refresh_from_db()
        self.assertTrue(s1.is_published)
        self.assertTrue(s2.is_published)

    def test_select_across_preserves_changelist_filter(self):
        included = _make_semester(year=2024, season=1)
        excluded = _make_semester(year=2023, season=1)

        url = f"{reverse('admin:projects_semester_changelist')}?year__exact=2024"
        data = {
            "action": "publish_selected",
            "index": "0",
            "select_across": "1",
            helpers.ACTION_CHECKBOX_NAME: [""],
        }
        self.client.post(url, data)

        confirm_url = reverse("admin:projects_semester_confirm_action")
        response = self.client.get(confirm_url)
        self.assertContains(response, "1")
        self.client.post(confirm_url, _confirm_action_data(self.client, "semester"))

        included.refresh_from_db()
        excluded.refresh_from_db()
        self.assertTrue(included.is_published)
        self.assertFalse(excluded.is_published)
