from django.test import TestCase

from apps.core.models import GmailAccessAccount


class GmailAccessAccountModelTests(TestCase):
    def test_load_prefers_active_config(self):
        fallback = GmailAccessAccount.objects.create(
            name="Fallback",
            imap_host="imap.gmail.com",
            gmail_username="fallback@example.com",
            gmail_password="fallback-pass",
        )
        active = GmailAccessAccount.objects.create(
            name="Active",
            is_active=True,
            imap_host="imap.gmail.com",
            gmail_username="active@example.com",
            gmail_password="active-pass",
        )

        loaded = GmailAccessAccount.load()

        self.assertEqual(loaded.pk, active.pk)
        self.assertNotEqual(loaded.pk, fallback.pk)
        self.assertEqual(loaded.mailbox, "active@example.com")

    def test_is_configured_requires_host_username_and_password(self):
        config = GmailAccessAccount.objects.create(
            name="Incomplete",
            imap_host="imap.gmail.com",
            gmail_username="",
            gmail_password="",
        )

        self.assertFalse(config.is_configured)

        config.gmail_username = "campaigns@example.com"
        config.gmail_password = "app-password"

        self.assertTrue(config.is_configured)

    def test_save_deactivates_other_active_configs(self):
        first = GmailAccessAccount.objects.create(
            name="First",
            is_active=True,
            imap_host="imap.gmail.com",
            gmail_username="first@example.com",
            gmail_password="first-pass",
        )
        second = GmailAccessAccount.objects.create(
            name="Second",
            imap_host="imap.gmail.com",
            gmail_username="second@example.com",
            gmail_password="second-pass",
        )

        second.is_active = True
        second.save()

        first.refresh_from_db()
        second.refresh_from_db()
        self.assertFalse(first.is_active)
        self.assertTrue(second.is_active)
