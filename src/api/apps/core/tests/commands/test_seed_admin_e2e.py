import io
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from django.utils import timezone

from apps.authn.models import ContactEmail
from apps.scheduling.models import (
    Event,
    Participant,
    RosterImportBatch,
    RosterImportReceipt,
    UserEvent,
    Weight,
)


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

    def test_seeds_idempotent_admin_nonstaff_action_contact_and_scheduling_data(self):
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

        event = Event.objects.get(code="E2EADMIN")
        self.assertEqual(event.name, "E2E Design Review")
        self.assertEqual(event.organizer, admin_member)
        self.assertEqual(event.mode, "mixed")
        self.assertEqual(event.location, "Design Studio")
        self.assertEqual(event.status, Event.Status.ACTIVE)
        self.assertEqual(event.access_mode, "open_link")

        participant = Participant.objects.get(event=event, member=nonstaff_member)
        self.assertEqual(participant.participant_name, "Nonstaff E2E")
        self.assertTrue(participant.submitted)
        self.assertEqual(len(participant.availability_inperson), 80)
        self.assertEqual(participant.group_name, "Design Review")
        weight = Weight.objects.get(event=event, participant=participant)
        self.assertEqual(weight.weight, 0.75)
        self.assertTrue(weight.included)
        self.assertEqual(
            set(UserEvent.objects.filter(event=event).values_list("member_id", "role")),
            {(admin_member.pk, "organizer"), (nonstaff_member.pk, "participant")},
        )

        seeded_member_count = Member.objects.filter(
            contact_emails__email_address__contains="e2e-test@example.com"
        ).count()
        self.assertEqual(seeded_member_count, 2)
        self.assertIn("Seeded admin E2E data", out.getvalue())
        self.assertEqual(Event.objects.filter(code="E2EADMIN").count(), 1)
        self.assertEqual(Participant.objects.filter(event=event).count(), 1)

    def test_reseed_replaces_mutated_event_and_stale_identity_links(self):
        first_options = {
            "email": "first-admin-e2e@example.com",
            "password": "safe-test-password",
            "nonstaff_email": "first-member-e2e@example.com",
            "action_email": "first-action-e2e@example.com",
        }
        call_command("seed_admin_e2e", "--yes", **first_options)
        old_event = Event.objects.get(code="E2EADMIN")
        old_event.status = Event.Status.FINALIZED
        old_event.save(update_fields=["status"])
        old_participant_id = Participant.objects.get(event=old_event).pk

        second_options = {
            "email": "second-admin-e2e@example.com",
            "password": "safe-test-password",
            "nonstaff_email": "second-member-e2e@example.com",
            "action_email": "second-action-e2e@example.com",
        }
        call_command("seed_admin_e2e", "--yes", **second_options)

        new_event = Event.objects.get(code="E2EADMIN")
        second_admin = ContactEmail.objects.get(email_address="second-admin-e2e@example.com").member
        second_member = ContactEmail.objects.get(
            email_address="second-member-e2e@example.com"
        ).member
        self.assertNotEqual(new_event.pk, old_event.pk)
        self.assertEqual(new_event.status, Event.Status.ACTIVE)
        self.assertFalse(Participant.objects.filter(pk=old_participant_id).exists())
        self.assertEqual(
            set(UserEvent.objects.filter(event=new_event).values_list("member_id", "role")),
            {(second_admin.pk, "organizer"), (second_member.pk, "participant")},
        )

    def test_reseed_replaces_event_with_committed_roster_imports(self):
        organizer = get_user_model().objects.create_user(
            password="safe-test-password",
            is_active=True,
        )
        stale_event = Event.objects.create(
            code="E2EADMIN",
            name="Stale seed",
            organizer=organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        batch = RosterImportBatch.objects.create(
            event=stale_event,
            created_by=organizer,
            source_type=RosterImportBatch.SourceType.CSV,
            status=RosterImportBatch.Status.COMMITTED,
            expires_at=timezone.now() + timedelta(hours=1),
        )
        receipt = RosterImportReceipt.objects.create(
            event=stale_event,
            batch=batch,
            committed_by=organizer,
            idempotency_key=uuid.uuid4(),
            request_fingerprint="f" * 64,
            mode=RosterImportReceipt.Mode.MERGE,
            results_revision=1,
        )

        call_command(
            "seed_admin_e2e",
            "--yes",
            email="roster-admin-e2e@example.com",
            password="safe-test-password",
            nonstaff_email="roster-member-e2e@example.com",
            action_email="roster-action-e2e@example.com",
        )

        new_event = Event.objects.get(code="E2EADMIN")
        self.assertNotEqual(new_event.pk, stale_event.pk)
        self.assertFalse(Event.objects.filter(pk=stale_event.pk).exists())
        self.assertFalse(RosterImportBatch.objects.filter(pk=batch.pk).exists())
        self.assertFalse(RosterImportReceipt.objects.filter(pk=receipt.pk).exists())
