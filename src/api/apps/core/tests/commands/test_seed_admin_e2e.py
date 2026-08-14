import io
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase

from apps.authn.models import ContactEmail
from apps.event.models import Event, Question, Ticket
from apps.projects.models import Project, Semester


class SeedAdminE2ECommandTests(TestCase):
    def test_requires_explicit_confirmation(self):
        with self.assertRaisesMessage(CommandError, "without --yes"):
            call_command("seed_admin_e2e")

    def test_refuses_production_settings(self):
        with patch.dict("os.environ", {"DJANGO_SETTINGS_MODULE": "config.settings.production"}):
            with self.assertRaisesMessage(CommandError, "production settings"):
                call_command("seed_admin_e2e", "--yes")

    def test_refuses_password_rejected_by_django_validators(self):
        with self.assertRaisesMessage(CommandError, "Refusing weak E2E admin password"):
            call_command(
                "seed_admin_e2e",
                "--yes",
                email="admin-e2e-test@example.com",
                password="password",
                nonstaff_email="nonstaff-e2e-test@example.com",
                action_email="action-e2e-test@example.com",
            )

    def test_seeds_idempotent_admin_nonstaff_action_contact_and_project_data(self):
        out = io.StringIO()
        options = {
            "email": "admin-e2e-test@example.com",
            "password": "safe-test-password",
            "nonstaff_email": "nonstaff-e2e-test@example.com",
            "action_email": "action-e2e-test@example.com",
            "stdout": out,
        }

        call_command("seed_admin_e2e", "--yes", **options)
        call_command("seed_admin_e2e", "--yes", **options)

        Member = get_user_model()
        admin_contact = ContactEmail.objects.get(email_address="admin-e2e-test@example.com")
        admin_member = admin_contact.member
        self.assertTrue(admin_member.is_active)
        self.assertTrue(admin_member.is_staff)
        self.assertTrue(admin_member.is_superuser)
        self.assertTrue(admin_member.check_password("safe-test-password"))
        self.assertTrue(admin_contact.verified)
        self.assertEqual(
            ContactEmail.objects.filter(email_address="admin-e2e-test@example.com").count(), 1
        )

        nonstaff_contact = ContactEmail.objects.get(email_address="nonstaff-e2e-test@example.com")
        nonstaff_member = nonstaff_contact.member
        self.assertTrue(nonstaff_member.is_active)
        self.assertFalse(nonstaff_member.is_staff)
        self.assertFalse(nonstaff_member.is_superuser)
        self.assertTrue(nonstaff_member.check_password("safe-test-password"))

        action_contact = ContactEmail.objects.get(email_address="action-e2e-test@example.com")
        self.assertIsNone(action_contact.member)
        self.assertEqual(action_contact.email_type, "other")
        self.assertFalse(action_contact.verified)
        self.assertTrue(action_contact.subscribe)

        semester = Semester.objects.get(year=2099, season=Semester.Season.FALL)
        project = Project.objects.get(semester=semester, team_number="E2E-1")
        self.assertEqual(str(semester), "2099-2 Fall")
        self.assertEqual(project.project_title, "E2E Solar Orchard Dashboard")
        self.assertEqual(project.organization, "Innovate To Grow QA")

        event = Event.objects.get(slug="e2e-event-copy-template")
        self.assertEqual(event.name, "E2E Event Copy Template")
        self.assertEqual(event.end_date.isoformat(), "2099-05-16")
        self.assertFalse(event.registration_open)
        self.assertTrue(event.collect_phone)
        self.assertTrue(event.verify_phone)
        self.assertEqual(
            list(Ticket.objects.filter(event=event).values_list("name", "order")),
            [("E2E General Admission", 1), ("E2E VIP Admission", 2)],
        )
        self.assertEqual(
            list(Question.objects.filter(event=event).values_list("text", "is_required", "order")),
            [
                ("What brings you to the E2E Event?", True, 1),
                ("Do you need accessibility accommodations?", False, 2),
            ],
        )

        seeded_member_count = Member.objects.filter(
            contact_emails__email_address__contains="e2e-test@example.com"
        ).count()
        self.assertEqual(seeded_member_count, 2)
        self.assertIn("Seeded admin E2E data", out.getvalue())
