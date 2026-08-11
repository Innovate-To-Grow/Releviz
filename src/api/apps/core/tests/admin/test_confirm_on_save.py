"""Tests for the ConfirmOnSaveMixin."""

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import reverse

from apps.authn.models import ContactEmail
from apps.cms.models import CMSEmbedAllowedHost

User = get_user_model()
CHANGE_SESSION_KEY = "_admin_pending_change_cms_cmsembedallowedhost"


def _make_superuser(email="admin@example.com"):
    user = User.objects.create_superuser(password="testpass123", first_name="Admin", last_name="User")
    ContactEmail.objects.create(member=user, email_address=email, email_type="primary", verified=True)
    return user


def _make_staff(email="staff@example.com"):
    user = User.objects.create_user(password="testpass123", is_staff=True, first_name="Staff", last_name="Member")
    ContactEmail.objects.create(member=user, email_address=email, email_type="primary", verified=True)
    return user


def _confirm_change_data(client, confirmation_word, *, token=None):
    return {
        "confirmation_word": confirmation_word,
        "token": token or client.session[CHANGE_SESSION_KEY]["token"],
    }


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmViewPerAppAccessTest(TestCase):
    """The confirm-change/confirm-action custom admin URLs are wrapped only in
    admin_view (is_staff); they must re-check per-app access so a staff member
    without the model's app cannot reach the confirmation diff."""

    def setUp(self):
        self.outsider = _make_staff(email="outsider@example.com")
        self.outsider.admin_apps = ["event"]  # NOT cms
        self.outsider.save(update_fields=["admin_apps"])
        self.client.login(username="outsider@example.com", password="testpass123")

    def test_non_app_staff_gets_403_on_confirm_change(self):
        url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        self.assertEqual(self.client.get(url).status_code, 403)

    def test_non_app_staff_gets_403_on_confirm_action(self):
        url = reverse("admin:cms_cmsembedallowedhost_confirm_action")
        self.assertEqual(self.client.get(url).status_code, 403)

    def test_app_staff_is_not_forbidden(self):
        self.outsider.admin_apps = ["cms"]
        self.outsider.save(update_fields=["admin_apps"])
        url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        # No pending change in session -> redirects to changelist, not a 403.
        self.assertNotEqual(self.client.get(url).status_code, 403)


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmOnSaveAddTest(TestCase):
    """Test confirmation flow for adding objects via admin."""

    def setUp(self):
        self.admin_user = _make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def test_add_post_redirects_to_confirmation_page(self):
        url = reverse("admin:cms_cmsembedallowedhost_add")
        response = self.client.post(url, {"hostname": "example.com", "is_active": True})

        self.assertEqual(response.status_code, 302)
        self.assertIn("confirm-change", response.url)

    def test_pending_change_uses_model_specific_session_key(self):
        url = reverse("admin:cms_cmsembedallowedhost_add")
        self.client.post(url, {"hostname": "session-key.com", "is_active": True})

        session = self.client.session
        self.assertIn(CHANGE_SESSION_KEY, session)
        self.assertNotIn("_admin_pending_change", session)

    def test_confirmation_page_shows_new_values(self):
        url = reverse("admin:cms_cmsembedallowedhost_add")
        self.client.post(url, {"hostname": "new-host.com", "is_active": True})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        response = self.client.get(confirm_url)

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Adding")
        self.assertContains(response, "new-host.com")

    def test_confirmation_page_requires_typed_word(self):
        url = reverse("admin:cms_cmsembedallowedhost_add")
        self.client.post(url, {"hostname": "typed-test.com", "is_active": True})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        response = self.client.get(confirm_url)

        self.assertContains(response, 'Type <strong>"')
        self.assertContains(response, "confirm-input")

    def test_wrong_confirmation_word_shows_error(self):
        url = reverse("admin:cms_cmsembedallowedhost_add")
        self.client.post(url, {"hostname": "wrong-word.com", "is_active": True})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        response = self.client.post(confirm_url, _confirm_change_data(self.client, "WRONG"), follow=True)

        self.assertContains(response, "Please type")
        self.assertFalse(CMSEmbedAllowedHost.objects.filter(hostname="wrong-word.com").exists())

    def test_invalid_token_clears_pending_change(self):
        url = reverse("admin:cms_cmsembedallowedhost_add")
        self.client.post(url, {"hostname": "bad-token.com", "is_active": True})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        response = self.client.post(
            confirm_url,
            _confirm_change_data(self.client, "cms embed allowed host", token="not-the-session-token"),
            follow=True,
        )

        self.assertContains(response, "Invalid confirmation token")
        self.assertFalse(CMSEmbedAllowedHost.objects.filter(hostname="bad-token.com").exists())
        self.assertNotIn(CHANGE_SESSION_KEY, self.client.session)

    def test_correct_confirmation_word_saves_object(self):
        url = reverse("admin:cms_cmsembedallowedhost_add")
        self.client.post(url, {"hostname": "confirmed.com", "is_active": True})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        confirmation_word = "cms embed allowed host"
        self.client.post(confirm_url, _confirm_change_data(self.client, confirmation_word))

        self.assertTrue(CMSEmbedAllowedHost.objects.filter(hostname="confirmed.com").exists())

    def test_case_insensitive_confirmation(self):
        url = reverse("admin:cms_cmsembedallowedhost_add")
        self.client.post(url, {"hostname": "case-test.com", "is_active": True})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        self.client.post(confirm_url, _confirm_change_data(self.client, "CMS Embed Allowed Host"))

        self.assertTrue(CMSEmbedAllowedHost.objects.filter(hostname="case-test.com").exists())

    @patch("apps.authn.services.email.send_email.senders.send_notification_email")
    def test_confirmed_add_does_not_notify_staff(self, mock_send):
        _make_staff(email="other-staff@example.com")

        url = reverse("admin:cms_cmsembedallowedhost_add")
        self.client.post(url, {"hostname": "notify-add.com", "is_active": True})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        self.client.post(confirm_url, _confirm_change_data(self.client, "cms embed allowed host"))

        self.assertTrue(CMSEmbedAllowedHost.objects.filter(hostname="notify-add.com").exists())
        mock_send.assert_not_called()


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmOnSaveChangeTest(TestCase):
    """Test confirmation flow for changing objects via admin."""

    def setUp(self):
        self.admin_user = _make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")
        self.host = CMSEmbedAllowedHost.objects.create(hostname="original.com", is_active=True)

    def test_change_post_redirects_to_confirmation(self):
        url = reverse("admin:cms_cmsembedallowedhost_change", args=[self.host.pk])
        response = self.client.post(url, {"hostname": "changed.com", "is_active": True})

        self.assertEqual(response.status_code, 302)
        self.assertIn("confirm-change", response.url)

    def test_confirmation_page_shows_diff(self):
        url = reverse("admin:cms_cmsembedallowedhost_change", args=[self.host.pk])
        self.client.post(url, {"hostname": "changed.com", "is_active": True})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        response = self.client.get(confirm_url)

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Changing")
        self.assertContains(response, "original.com")
        self.assertContains(response, "changed.com")

    def test_confirmed_change_updates_object(self):
        url = reverse("admin:cms_cmsembedallowedhost_change", args=[self.host.pk])
        self.client.post(url, {"hostname": "updated.com", "is_active": True})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        self.client.post(confirm_url, _confirm_change_data(self.client, "cms embed allowed host"))

        self.host.refresh_from_db()
        self.assertEqual(self.host.hostname, "updated.com")

    def test_no_change_skips_confirmation(self):
        url = reverse("admin:cms_cmsembedallowedhost_change", args=[self.host.pk])
        response = self.client.post(url, {"hostname": "original.com", "is_active": True})

        self.assertNotIn("confirm-change", response.url if response.status_code == 302 else "")

    @patch("apps.authn.services.email.send_email.senders.send_notification_email")
    def test_confirmed_change_does_not_notify_staff(self, mock_send):
        _make_staff(email="notify-change@example.com")

        url = reverse("admin:cms_cmsembedallowedhost_change", args=[self.host.pk])
        self.client.post(url, {"hostname": "notify-changed.com", "is_active": True})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        self.client.post(confirm_url, _confirm_change_data(self.client, "cms embed allowed host"))

        self.host.refresh_from_db()
        self.assertEqual(self.host.hostname, "notify-changed.com")
        mock_send.assert_not_called()


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmOnSaveDeleteTest(TestCase):
    """Test confirmation flow for deleting objects via admin."""

    def setUp(self):
        self.admin_user = _make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")
        self.host = CMSEmbedAllowedHost.objects.create(hostname="to-delete.com", is_active=True)

    def test_delete_post_redirects_to_confirmation(self):
        url = reverse("admin:cms_cmsembedallowedhost_delete", args=[self.host.pk])
        response = self.client.post(url, {"post": "yes"})

        self.assertEqual(response.status_code, 302)
        self.assertIn("confirm-change", response.url)

    def test_confirmation_page_shows_delete_details(self):
        url = reverse("admin:cms_cmsembedallowedhost_delete", args=[self.host.pk])
        self.client.post(url, {"post": "yes"})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        response = self.client.get(confirm_url)

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Deleting")
        self.assertContains(response, "to-delete.com")

    def test_confirmed_delete_removes_object(self):
        url = reverse("admin:cms_cmsembedallowedhost_delete", args=[self.host.pk])
        self.client.post(url, {"post": "yes"})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        self.client.post(confirm_url, _confirm_change_data(self.client, "cms embed allowed host"))

        self.assertFalse(CMSEmbedAllowedHost.objects.filter(pk=self.host.pk).exists())

    def test_wrong_word_does_not_delete(self):
        url = reverse("admin:cms_cmsembedallowedhost_delete", args=[self.host.pk])
        self.client.post(url, {"post": "yes"})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        self.client.post(confirm_url, _confirm_change_data(self.client, "NOPE"), follow=True)

        self.assertTrue(CMSEmbedAllowedHost.objects.filter(pk=self.host.pk).exists())

    @patch("apps.authn.services.email.send_email.senders.send_notification_email")
    def test_confirmed_delete_does_not_notify_staff(self, mock_send):
        _make_staff(email="notify-del@example.com")

        url = reverse("admin:cms_cmsembedallowedhost_delete", args=[self.host.pk])
        self.client.post(url, {"post": "yes"})

        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        self.client.post(confirm_url, _confirm_change_data(self.client, "cms embed allowed host"))

        self.assertFalse(CMSEmbedAllowedHost.objects.filter(pk=self.host.pk).exists())
        mock_send.assert_not_called()


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmOnSaveSkipTest(TestCase):
    """Test that confirmation is skipped in appropriate cases."""

    def setUp(self):
        self.admin_user = _make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def test_popup_mode_skips_confirmation(self):
        url = reverse("admin:cms_cmsembedallowedhost_add")
        response = self.client.post(url, {"hostname": "popup.com", "is_active": True, "_popup": "1"})

        self.assertNotIn("confirm-change", response.url if response.status_code == 302 else "")
        self.assertTrue(CMSEmbedAllowedHost.objects.filter(hostname="popup.com").exists())

    def test_no_pending_change_shows_error(self):
        confirm_url = reverse("admin:cms_cmsembedallowedhost_confirm_change")
        response = self.client.get(confirm_url, follow=True)

        self.assertContains(response, "No pending change found")

    @override_settings(ADMIN_REQUIRE_CONFIRMATION=False)
    def test_disabled_setting_saves_directly(self):
        url = reverse("admin:cms_cmsembedallowedhost_add")
        response = self.client.post(url, {"hostname": "direct-save.com", "is_active": True})

        self.assertTrue(CMSEmbedAllowedHost.objects.filter(hostname="direct-save.com").exists())


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ConfirmOnSaveValidationTest(TestCase):
    """Test that form validation errors are shown normally without confirmation."""

    def setUp(self):
        self.admin_user = _make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def test_invalid_form_shows_errors_not_confirmation(self):
        url = reverse("admin:cms_cmsembedallowedhost_add")
        response = self.client.post(url, {"hostname": "", "is_active": True})

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("confirm-change", response.get("Location", ""))
