import io
import uuid
from datetime import timedelta

from django.contrib.admin.models import ADDITION, LogEntry
from django.contrib.contenttypes.models import ContentType
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from django.utils import timezone

from apps.authn.models import ContactEmail, EmailAuthChallenge, Member
from apps.authn.tests.helpers import create_member
from apps.core.models import AWSCredentialConfig, SiteMaintenanceControl
from apps.mail.models import (
    EmailDeliveryJob,
    EmailDeliveryRequest,
    EmailMessageLog,
    EmailProviderConfig,
)
from apps.scheduling.models import (
    Event,
    EventDeletionRecord,
    EventInvitation,
    Participant,
    RosterImportBatch,
    RosterImportReceipt,
    TemporaryEventSession,
    UserEvent,
)


class PurgeSchedulingDataCommandTests(TestCase):
    def setUp(self):
        self.full_member = create_member("preserved@example.com", "Full", "Member")
        self.full_member.is_staff = True
        self.full_member.save(update_fields=["is_staff", "updated_at"])
        self.temp_member = create_member(
            "temporary@example.com",
            "Temporary",
            "Member",
            access_level=Member.AccessLevel.TEMPORARY,
        )
        self.event = Event.objects.create(
            code="PURGE001",
            name="Purge me",
            organizer=self.full_member,
            status=Event.Status.ACTIVE,
            opened_at=timezone.now(),
        )
        UserEvent.objects.create(
            member=self.full_member,
            event=self.event,
            role="organizer",
        )
        self.participant = Participant.objects.create(
            event=self.event,
            member=self.temp_member,
            participant_name="Temporary Member",
        )
        self.invitation = EventInvitation.objects.create(
            event=self.event,
            email="temporary@example.com",
            member=self.temp_member,
            invited_by=self.full_member,
        )
        TemporaryEventSession.objects.create(
            member=self.temp_member,
            participant=self.participant,
            invitation=self.invitation,
            secret_hash="a" * 64,
            expires_at=timezone.now() + timedelta(hours=1),
        )
        batch = RosterImportBatch.objects.create(
            event=self.event,
            created_by=self.full_member,
            source_type=RosterImportBatch.SourceType.CSV,
            expires_at=timezone.now() + timedelta(hours=1),
        )
        RosterImportReceipt.objects.create(
            event=self.event,
            batch=batch,
            committed_by=self.full_member,
            idempotency_key=uuid.uuid4(),
            request_fingerprint="f" * 64,
            mode=RosterImportReceipt.Mode.MERGE,
            results_revision=1,
        )
        EventDeletionRecord.objects.create(
            event_id=uuid.uuid4(),
            code="DELETED1",
            organizer=self.full_member,
            idempotency_key=uuid.uuid4(),
            request_fingerprint="d" * 64,
            deleted_version=1,
        )
        self.temp_challenge = EmailAuthChallenge.objects.create(
            member=self.temp_member,
            purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS,
            target_email="temporary@example.com",
            expires_at=timezone.now() + timedelta(minutes=10),
        )
        self.full_challenge = EmailAuthChallenge.objects.create(
            member=self.full_member,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="preserved@example.com",
            expires_at=timezone.now() + timedelta(minutes=10),
        )
        self.job = EmailDeliveryJob.objects.create(
            idempotency_key="purge-scheduling-job",
            message_type=EmailMessageLog.MessageType.INVITATION,
            recipient="temporary@example.com",
            subject="Invitation",
            body="Body",
            message_id="<purge-scheduling-job@example.com>",
            event=self.event,
            member=self.temp_member,
            auth_challenge=self.temp_challenge,
            invitation=self.invitation,
        )
        request = EmailDeliveryRequest.objects.create(
            event=self.event,
            requested_by=self.full_member,
            operation=EmailDeliveryRequest.Operation.INVITATION,
            idempotency_key=uuid.uuid4(),
            request_fingerprint="r" * 64,
            recipient_count=1,
            created_job_count=1,
        )
        request.jobs.add(self.job)
        EmailMessageLog.objects.create(
            message_type=EmailMessageLog.MessageType.INVITATION,
            recipient="temporary@example.com",
            subject="Invitation",
            status=EmailMessageLog.Status.SENT,
            event=self.event,
            invitation=self.invitation,
            delivery_job=self.job,
        )
        self.temp_verification_log = EmailMessageLog.objects.create(
            message_type=EmailMessageLog.MessageType.VERIFICATION,
            recipient="temporary@example.com",
            subject="Temporary verification",
            status=EmailMessageLog.Status.SENT,
        )
        self.unrelated_log = EmailMessageLog.objects.create(
            message_type=EmailMessageLog.MessageType.TEST,
            recipient="preserved@example.com",
            subject="Preserve",
            status=EmailMessageLog.Status.SENT,
        )
        self.aws_config = AWSCredentialConfig.objects.create(name="Preserved AWS")
        self.email_config = EmailProviderConfig.objects.create(
            name="Preserved email",
            from_email="sender@example.com",
        )
        LogEntry.objects.create(
            user_id=self.full_member.pk,
            content_type=ContentType.objects.get_for_model(Event),
            object_id=str(self.event.pk),
            object_repr=str(self.event),
            action_flag=ADDITION,
        )
        LogEntry.objects.create(
            user_id=self.full_member.pk,
            content_type=ContentType.objects.get_for_model(Member),
            object_id=str(self.temp_member.pk),
            object_repr=str(self.temp_member),
            action_flag=ADDITION,
        )

    def execute(self, *, expected=1):
        output = io.StringIO()
        call_command(
            "purge_scheduling_data",
            execute=True,
            confirm="PURGE-SCHEDULING-DATA",
            expected_event_count=expected,
            stdout=output,
        )
        return output.getvalue()

    def test_default_is_a_non_mutating_dry_run(self):
        output = io.StringIO()
        call_command("purge_scheduling_data", stdout=output)
        self.assertIn('"dryRun": true', output.getvalue())
        self.assertTrue(Event.objects.filter(pk=self.event.pk).exists())
        self.assertTrue(Member.objects.filter(pk=self.temp_member.pk).exists())
        self.assertFalse(SiteMaintenanceControl.objects.exists())

    def test_execution_requires_confirmation_maintenance_and_matching_event_count(self):
        with self.assertRaisesMessage(CommandError, "--confirm PURGE-SCHEDULING-DATA"):
            call_command(
                "purge_scheduling_data",
                execute=True,
                expected_event_count=1,
            )
        with self.assertRaisesMessage(CommandError, "Maintenance mode"):
            call_command(
                "purge_scheduling_data",
                execute=True,
                confirm="PURGE-SCHEDULING-DATA",
                expected_event_count=1,
            )
        SiteMaintenanceControl.objects.create(is_maintenance=True)
        with self.assertRaisesMessage(CommandError, "expected 2, found 1"):
            self.execute(expected=2)
        self.assertTrue(Event.objects.filter(pk=self.event.pk).exists())

    def test_execution_refuses_a_targeted_processing_email_job(self):
        SiteMaintenanceControl.objects.create(is_maintenance=True)
        self.job.status = EmailDeliveryJob.Status.PROCESSING
        self.job.save(update_fields=["status", "updated_at"])
        with self.assertRaisesMessage(CommandError, "delivery job is processing"):
            self.execute()
        self.assertTrue(Event.objects.filter(pk=self.event.pk).exists())

    def test_execution_refuses_a_privileged_temporary_member(self):
        SiteMaintenanceControl.objects.create(is_maintenance=True)
        self.temp_member.is_staff = True
        self.temp_member.save(update_fields=["is_staff", "updated_at"])
        with self.assertRaisesMessage(CommandError, "staff or superuser"):
            self.execute()
        self.assertTrue(Event.objects.filter(pk=self.event.pk).exists())
        self.assertTrue(Member.objects.filter(pk=self.temp_member.pk).exists())

    def test_execution_clears_scheduling_and_temporary_members_only(self):
        SiteMaintenanceControl.objects.create(is_maintenance=True)
        output = self.execute()
        self.assertIn('"dryRun": false', output)

        self.assertFalse(Event.objects.exists())
        self.assertFalse(EventDeletionRecord.objects.exists())
        self.assertFalse(RosterImportReceipt.objects.exists())
        self.assertFalse(TemporaryEventSession.objects.exists())
        self.assertFalse(EmailDeliveryRequest.objects.exists())
        self.assertFalse(EmailDeliveryJob.objects.exists())
        self.assertFalse(
            EmailMessageLog.objects.filter(
                message_type=EmailMessageLog.MessageType.INVITATION
            ).exists()
        )
        self.assertFalse(EmailMessageLog.objects.filter(pk=self.temp_verification_log.pk).exists())
        self.assertFalse(Member.objects.filter(pk=self.temp_member.pk).exists())
        self.assertFalse(ContactEmail.objects.filter(member_id=self.temp_member.pk).exists())
        self.assertFalse(EmailAuthChallenge.objects.filter(pk=self.temp_challenge.pk).exists())

        self.assertTrue(Member.objects.filter(pk=self.full_member.pk).exists())
        self.assertTrue(ContactEmail.objects.filter(member_id=self.full_member.pk).exists())
        self.assertTrue(EmailAuthChallenge.objects.filter(pk=self.full_challenge.pk).exists())
        self.assertTrue(EmailMessageLog.objects.filter(pk=self.unrelated_log.pk).exists())
        self.assertTrue(AWSCredentialConfig.objects.filter(pk=self.aws_config.pk).exists())
        self.assertTrue(EmailProviderConfig.objects.filter(pk=self.email_config.pk).exists())
        self.assertFalse(LogEntry.objects.filter(content_type__app_label="scheduling").exists())
        self.assertFalse(
            LogEntry.objects.filter(
                content_type__app_label="authn",
                content_type__model="member",
                object_id=str(self.temp_member.pk),
            ).exists()
        )
