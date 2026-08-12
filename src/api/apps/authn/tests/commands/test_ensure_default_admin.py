import io
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError
from django.test import TestCase

from apps.authn.management.ensure_default_admin import Command
from apps.authn.models import ContactEmail


class EnsureDefaultAdminCommandTests(TestCase):
    def test_requires_explicit_confirmation(self):
        with self.assertRaisesMessage(CommandError, "without --yes"):
            call_command(Command(), email="demo-admin@example.com")

    def test_requires_password_env(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesMessage(CommandError, "DJANGO_SUPERUSER_PASSWORD must be set"):
                call_command(Command(), yes=True, email="demo-admin@example.com")

    def test_creates_default_admin_once_and_leaves_it_unchanged(self):
        out = io.StringIO()

        with patch.dict("os.environ", {"DJANGO_SUPERUSER_PASSWORD": "safe-demo-password"}):
            call_command(
                Command(),
                yes=True,
                email="demo-admin@example.com",
                first_name="Demo",
                last_name="Admin",
                stdout=out,
            )

        with patch.dict("os.environ", {"DJANGO_SUPERUSER_PASSWORD": "replacement-password"}):
            call_command(
                Command(),
                yes=True,
                email="demo-admin@example.com",
                first_name="Replacement",
                last_name="Name",
                stdout=out,
            )

        Member = get_user_model()
        contact = ContactEmail.objects.get(email_address="demo-admin@example.com")
        member = contact.member

        self.assertEqual(Member.objects.count(), 1)
        self.assertEqual(
            ContactEmail.objects.filter(email_address="demo-admin@example.com").count(), 1
        )
        self.assertEqual(member.first_name, "Demo")
        self.assertEqual(member.last_name, "Admin")
        self.assertTrue(member.is_active)
        self.assertTrue(member.is_staff)
        self.assertTrue(member.is_superuser)
        self.assertTrue(member.check_password("safe-demo-password"))
        self.assertEqual(contact.email_type, "primary")
        self.assertTrue(contact.verified)
        self.assertIn("Default admin created", out.getvalue())
        self.assertIn("already exists; left unchanged", out.getvalue())

    def test_existing_member_is_never_promoted_or_reset(self):
        Member = get_user_model()
        member = Member.objects.create_user(
            password="old-password",
            first_name="Old",
            last_name="User",
            is_active=False,
            is_staff=False,
            is_superuser=False,
        )
        ContactEmail.objects.create(
            member=member,
            email_address="existing@example.com",
            email_type="primary",
            verified=False,
            subscribe=False,
        )

        with patch.dict("os.environ", {"DJANGO_SUPERUSER_PASSWORD": "new-password"}):
            with self.assertRaisesMessage(CommandError, "not an active staff superuser"):
                call_command(
                    Command(),
                    yes=True,
                    email="existing@example.com",
                    first_name="Default",
                    last_name="Admin",
                    stdout=io.StringIO(),
                )

        member.refresh_from_db()
        contact = ContactEmail.objects.get(email_address="existing@example.com")
        self.assertEqual(contact.member, member)
        self.assertEqual(member.first_name, "Old")
        self.assertEqual(member.last_name, "User")
        self.assertFalse(member.is_active)
        self.assertFalse(member.is_staff)
        self.assertFalse(member.is_superuser)
        self.assertTrue(member.check_password("old-password"))
        self.assertFalse(contact.verified)
        self.assertFalse(contact.subscribe)

    def test_unowned_contact_is_claimed_by_new_admin(self):
        contact = ContactEmail.objects.create(
            member=None,
            email_address="subscribed@example.com",
            email_type="other",
            verified=False,
            subscribe=False,
        )

        with patch.dict("os.environ", {"DJANGO_SUPERUSER_PASSWORD": "safe-demo-password"}):
            call_command(
                Command(),
                yes=True,
                email="subscribed@example.com",
                first_name="Default",
                last_name="Admin",
                stdout=io.StringIO(),
            )

        contact.refresh_from_db()
        member = contact.member
        self.assertEqual(
            ContactEmail.objects.filter(email_address="subscribed@example.com").count(), 1
        )
        self.assertTrue(member.is_active)
        self.assertTrue(member.is_staff)
        self.assertTrue(member.is_superuser)
        self.assertTrue(member.check_password("safe-demo-password"))
        self.assertEqual(contact.email_type, "primary")
        self.assertTrue(contact.verified)
        self.assertFalse(contact.subscribe)

    def test_concurrent_compliant_winner_is_treated_as_idempotent(self):
        Member = get_user_model()
        winner = Member.objects.create_user(
            password="winner-password",
            first_name="Winner",
            last_name="Admin",
            is_active=True,
            is_staff=True,
            is_superuser=True,
        )
        winner_contact = ContactEmail.objects.create(
            member=winner,
            email_address="race@example.com",
            email_type="primary",
            verified=True,
            subscribe=False,
        )
        out = io.StringIO()

        # Simulate the first lookup's snapshot missing a row which is visible
        # by the time get_or_create handles the competing insert.
        with (
            patch.object(Command, "_find_contact_for_update", side_effect=[None, winner_contact]),
            patch.dict("os.environ", {"DJANGO_SUPERUSER_PASSWORD": "loser-password"}),
        ):
            call_command(
                Command(),
                yes=True,
                email="race@example.com",
                stdout=out,
            )

        self.assertEqual(Member.objects.count(), 1)
        self.assertEqual(ContactEmail.objects.filter(email_address="race@example.com").count(), 1)
        winner.refresh_from_db()
        winner_contact.refresh_from_db()
        self.assertTrue(winner.check_password("winner-password"))
        self.assertFalse(winner_contact.subscribe)
        self.assertIn("already exists; left unchanged", out.getvalue())

    def test_concurrent_non_admin_winner_is_rejected_unchanged(self):
        Member = get_user_model()
        winner = Member.objects.create_user(
            password="winner-password",
            first_name="Ordinary",
            last_name="Member",
            is_active=True,
            is_staff=False,
            is_superuser=False,
        )
        winner_contact = ContactEmail.objects.create(
            member=winner,
            email_address="race@example.com",
            email_type="primary",
            verified=True,
            subscribe=False,
        )

        with (
            patch.object(Command, "_find_contact_for_update", side_effect=[None, winner_contact]),
            patch.dict("os.environ", {"DJANGO_SUPERUSER_PASSWORD": "loser-password"}),
            self.assertRaisesMessage(CommandError, "not an active staff superuser"),
        ):
            call_command(
                Command(),
                yes=True,
                email="race@example.com",
                stdout=io.StringIO(),
            )

        self.assertEqual(Member.objects.count(), 1)
        winner.refresh_from_db()
        winner_contact.refresh_from_db()
        self.assertTrue(winner.check_password("winner-password"))
        self.assertFalse(winner.is_staff)
        self.assertFalse(winner.is_superuser)
        self.assertTrue(winner_contact.verified)
        self.assertFalse(winner_contact.subscribe)

    def test_unrelated_integrity_error_is_not_treated_as_a_concurrent_winner(self):
        with (
            patch.object(
                ContactEmail.objects,
                "get_or_create",
                side_effect=IntegrityError("unrelated constraint"),
            ),
            patch.dict("os.environ", {"DJANGO_SUPERUSER_PASSWORD": "safe-demo-password"}),
            self.assertRaisesMessage(IntegrityError, "unrelated constraint"),
        ):
            call_command(
                Command(),
                yes=True,
                email="new@example.com",
                stdout=io.StringIO(),
            )

        self.assertEqual(get_user_model().objects.count(), 0)

    def test_existing_admin_does_not_require_password_secret(self):
        Member = get_user_model()
        member = Member.objects.create_user(
            password="existing-password",
            first_name="Existing",
            last_name="Admin",
            is_active=True,
            is_staff=True,
            is_superuser=True,
        )
        ContactEmail.objects.create(
            member=member,
            email_address="existing-admin@example.com",
            email_type="primary",
            verified=True,
            subscribe=True,
        )

        with patch.dict("os.environ", {}, clear=True):
            call_command(
                Command(),
                yes=True,
                email="existing-admin@example.com",
                stdout=io.StringIO(),
            )

        member.refresh_from_db()
        self.assertTrue(member.check_password("existing-password"))

    def test_existing_admin_with_unverified_contact_is_rejected_unchanged(self):
        Member = get_user_model()
        member = Member.objects.create_user(
            password="existing-password",
            first_name="Existing",
            last_name="Admin",
            is_active=True,
            is_staff=True,
            is_superuser=True,
        )
        contact = ContactEmail.objects.create(
            member=member,
            email_address="unverified-admin@example.com",
            email_type="primary",
            verified=False,
            subscribe=False,
        )

        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesMessage(CommandError, "contact is not verified"):
                call_command(
                    Command(),
                    yes=True,
                    email="unverified-admin@example.com",
                    stdout=io.StringIO(),
                )

        member.refresh_from_db()
        contact.refresh_from_db()
        self.assertEqual(member.first_name, "Existing")
        self.assertEqual(member.last_name, "Admin")
        self.assertTrue(member.is_active)
        self.assertTrue(member.is_staff)
        self.assertTrue(member.is_superuser)
        self.assertTrue(member.check_password("existing-password"))
        self.assertFalse(contact.verified)
        self.assertFalse(contact.subscribe)
