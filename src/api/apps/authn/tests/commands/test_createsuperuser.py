from io import StringIO
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.test import TestCase

from apps.authn.management.commands.createsuperuser import Command
from apps.authn.models import ContactEmail

Member = get_user_model()


class CreateSuperuserCommandTests(TestCase):
    def test_noninteractive_requires_first_and_last_name(self):
        with self.assertRaisesMessage(
            CommandError,
            "--email, --password, --first-name, and --last-name are required in non-interactive mode.",
        ):
            call_command(
                Command(),
                interactive=False,
                email="admin@example.com",
                password="StrongPass123!",
            )

    def test_noninteractive_creates_superuser_with_names(self):
        stdout = StringIO()

        call_command(
            Command(),
            interactive=False,
            email="admin@example.com",
            password="StrongPass123!",
            first_name="Admin",
            last_name="User",
            stdout=stdout,
        )

        member = ContactEmail.objects.get(email_address="admin@example.com").member
        self.assertTrue(member.is_superuser)
        self.assertEqual(member.first_name, "Admin")
        self.assertEqual(member.last_name, "User")


class CreateSuperuserInteractiveTests(TestCase):
    def test_noninteractive_rejects_duplicate_email(self):
        member = Member.objects.create_user(
            password="StrongPass123!", first_name="A", last_name="B"
        )
        ContactEmail.objects.create(
            member=member, email_address="dup@example.com", email_type="primary", verified=True
        )
        with self.assertRaisesMessage(
            CommandError, "A contact email with address 'dup@example.com' already exists."
        ):
            call_command(
                Command(),
                interactive=False,
                email="dup@example.com",
                password="StrongPass123!",
                first_name="Admin",
                last_name="User",
            )

    @patch("getpass.getpass")
    @patch("builtins.input")
    def test_interactive_creates_superuser(self, mock_input, mock_getpass):
        # Email prompt, then first name, then last name.
        mock_input.side_effect = ["new-admin@example.com", "Ada", "Lovelace"]
        mock_getpass.side_effect = ["StrongPass123!", "StrongPass123!"]
        stdout = StringIO()

        call_command(Command(), stdout=stdout)

        member = ContactEmail.objects.get(email_address="new-admin@example.com").member
        self.assertTrue(member.is_superuser)
        self.assertEqual(member.first_name, "Ada")
        self.assertEqual(member.last_name, "Lovelace")
        self.assertIn("Superuser created", stdout.getvalue())

    @patch("getpass.getpass")
    @patch("builtins.input")
    def test_interactive_reprompts_on_blank_email_then_duplicate(self, mock_input, mock_getpass):
        existing = Member.objects.create_user(
            password="StrongPass123!", first_name="A", last_name="B"
        )
        ContactEmail.objects.create(
            member=existing, email_address="taken@example.com", email_type="primary", verified=True
        )
        # blank email -> reprompt; duplicate email -> reprompt; finally a valid email,
        # then first name and last name.
        mock_input.side_effect = ["", "taken@example.com", "ok@example.com", "Ada", "Lovelace"]
        mock_getpass.side_effect = ["StrongPass123!", "StrongPass123!"]
        stderr = StringIO()

        call_command(Command(), stderr=stderr)

        self.assertTrue(ContactEmail.objects.filter(email_address="ok@example.com").exists())
        err = stderr.getvalue()
        self.assertIn("Email address cannot be blank", err)
        self.assertIn("already exists", err)

    @patch("getpass.getpass")
    @patch("builtins.input")
    def test_interactive_reprompts_on_password_mismatch_and_blank_names(
        self, mock_input, mock_getpass
    ):
        # email, then blank first name (reprompt), valid first, blank last (reprompt), valid last
        mock_input.side_effect = ["mismatch@example.com", "", "Ada", "", "Lovelace"]
        # mismatch then match
        mock_getpass.side_effect = ["pass-a", "pass-b", "StrongPass123!", "StrongPass123!"]
        stderr = StringIO()

        call_command(Command(), stderr=stderr)

        self.assertTrue(ContactEmail.objects.filter(email_address="mismatch@example.com").exists())
        err = stderr.getvalue()
        self.assertIn("Passwords do not match", err)
        self.assertIn("First name cannot be blank", err)
        self.assertIn("Last name cannot be blank", err)


class MemberManagerCreateSuperuserTests(TestCase):
    def test_create_superuser_requires_first_name(self):
        with self.assertRaisesMessage(ValueError, "Superuser first name is required."):
            Member.objects.create_superuser(password="StrongPass123!", last_name="User")

    def test_create_superuser_requires_last_name(self):
        with self.assertRaisesMessage(ValueError, "Superuser last name is required."):
            Member.objects.create_superuser(password="StrongPass123!", first_name="Admin")
