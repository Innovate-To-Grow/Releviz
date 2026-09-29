"""Admin searches find related members by their actual contact addresses."""

import uuid
from datetime import timedelta

from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from apps.authn.models import ContactEmail
from apps.core.tests.helpers import make_member, make_superuser
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.scheduling.models import (
    Event,
    EventDeletionRecord,
    EventDuplicationRequest,
    EventInvitation,
    Participant,
    ScheduleEditRecord,
    TemporaryEventSession,
)


class RelatedMemberEmailSearchTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin_user = make_superuser()
        matched_member = make_member(email="find-person@example.com")
        other_member = make_member(email="another-person@example.com")
        ContactEmail.objects.create(
            member=matched_member,
            email_address="find-person-alias@example.com",
            email_type="secondary",
            verified=True,
        )
        cls.expected = cls._create_related_records(matched_member, "MATCH")
        cls._create_related_records(other_member, "OTHER")

    @classmethod
    def _create_related_records(cls, member, code):
        event = Event.objects.create(code=code, name="Search example", organizer=member)
        participant = Participant.objects.create(
            event=event,
            member=member,
            participant_name="Participant",
        )
        invitation = EventInvitation.objects.create(
            event=event,
            member=member,
            email=f"invitation-{code.lower()}@example.com",
        )
        return [
            EventDuplicationRequest.objects.create(
                source_event=event,
                duplicate_event=None,
                requested_by=member,
                idempotency_key=uuid.uuid4(),
                request_fingerprint="fingerprint",
                source_version=1,
            ),
            EventDeletionRecord.objects.create(
                event_id=uuid.uuid4(),
                code=f"DELETED-{code}",
                organizer=member,
                idempotency_key=uuid.uuid4(),
                request_fingerprint="fingerprint",
                deleted_version=1,
            ),
            ScheduleEditRecord.objects.create(
                event=event,
                participant=participant,
                actor=member,
                source=ScheduleEditRecord.Source.SELF,
                action=ScheduleEditRecord.Action.SUBMIT,
                participant_version=1,
            ),
            TemporaryEventSession.objects.create(
                member=member,
                participant=participant,
                invitation=invitation,
                secret_hash=f"secret-{code}",
                expires_at=timezone.now() + timedelta(days=1),
            ),
            EmailDeliveryRequest.objects.create(
                event=event,
                requested_by=member,
                operation=EmailDeliveryRequest.Operation.INVITATION,
                idempotency_key=uuid.uuid4(),
                request_fingerprint="fingerprint",
            ),
            EmailDeliveryJob.objects.create(
                event=event,
                member=member,
                idempotency_key=f"job-{code}",
                message_type=EmailMessageLog.MessageType.TEST,
                recipient=f"recipient-{code.lower()}@example.com",
                subject="Search example",
                body="Body",
                message_id=f"message-{code}",
            ),
        ]

    def setUp(self):
        self.client.force_login(self.admin_user)

    def _assert_search_matches(self, search):
        for record in self.expected:
            opts = record._meta
            with self.subTest(model=opts.label, search=search):
                response = self.client.get(
                    reverse(f"admin:{opts.app_label}_{opts.model_name}_changelist"),
                    {"q": search},
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(list(response.context["cl"].result_list), [record])

    def test_search_finds_records_by_primary_contact_email(self):
        self._assert_search_matches("find-person@example.com")

    def test_multiple_matching_contact_emails_do_not_duplicate_records(self):
        self._assert_search_matches("find-person")
