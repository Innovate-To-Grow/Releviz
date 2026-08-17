import uuid
from unittest.mock import patch

from django.test import TestCase

from apps.authn.models import ContactEmail
from apps.authn.tests.helpers import create_member
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest
from apps.scheduling.models import Event, EventInvitation, Participant, UserEvent
from apps.scheduling.services.deliveries import (
    EventEmailRequestError,
    create_or_reuse_managed_participant_and_send,
)
from apps.scheduling.views.roster import _latest_delivery_request


class ActiveInvitationPipelineTests(TestCase):
    def setUp(self):
        self.organizer = create_member("active-pipeline-owner@example.com")
        self.event = Event.objects.create(
            code="ACTIVE01",
            name="Active pipeline",
            organizer=self.organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )

    def test_managed_request_replay_and_name_or_email_conflicts(self):
        key = uuid.uuid4()
        first = create_or_reuse_managed_participant_and_send(
            event=self.event,
            organizer=self.organizer,
            name="First Person",
            email="first@example.com",
            idempotency_key=key,
        )
        replay = create_or_reuse_managed_participant_and_send(
            event=self.event,
            organizer=self.organizer,
            name="First Person",
            email="FIRST@example.com",
            idempotency_key=key,
        )
        self.assertFalse(first["deliveryResult"]["idempotent"])
        self.assertTrue(replay["deliveryResult"]["idempotent"])
        self.assertEqual(
            first["deliveryResult"]["request"].pk,
            replay["deliveryResult"]["request"].pk,
        )

        for name, email in [
            ("Changed Name", "first@example.com"),
            ("First Person", "other@example.com"),
        ]:
            with self.subTest(name=name, email=email), self.assertRaises(EventEmailRequestError):
                create_or_reuse_managed_participant_and_send(
                    event=self.event,
                    organizer=self.organizer,
                    name=name,
                    email=email,
                    idempotency_key=key,
                )

    def test_hidden_participant_is_restored_and_auto_invited(self):
        first = create_or_reuse_managed_participant_and_send(
            event=self.event,
            organizer=self.organizer,
            name="Hidden Person",
            email="hidden@example.com",
            idempotency_key=uuid.uuid4(),
        )
        participant = first["participant"]
        participant.hidden = True
        participant.save(update_fields=["hidden", "updated_at"])

        restored = create_or_reuse_managed_participant_and_send(
            event=self.event,
            organizer=self.organizer,
            name="Restored Person",
            email="hidden@example.com",
            idempotency_key=uuid.uuid4(),
        )
        restored["participant"].refresh_from_db()
        self.assertTrue(restored["participantRestored"])
        self.assertFalse(restored["participant"].hidden)
        self.assertEqual(restored["deliveryResult"]["request"].recipient_count, 1)

        restored_participant = restored["participant"]
        restored_version = restored_participant.version
        restored_participant.hidden = True
        restored_participant.save(update_fields=["hidden", "updated_at"])
        same_name = create_or_reuse_managed_participant_and_send(
            event=self.event,
            organizer=self.organizer,
            name="Restored Person",
            email="hidden@example.com",
            idempotency_key=uuid.uuid4(),
        )
        same_name["participant"].refresh_from_db()
        self.assertTrue(same_name["participantRestored"])
        self.assertEqual(same_name["participant"].participant_name, "Restored Person")
        self.assertEqual(same_name["participant"].version, restored_version + 1)

    def test_invitation_enqueue_failure_rolls_back_the_entire_managed_add(self):
        email = "rollback@example.com"
        baseline_user_events = UserEvent.objects.filter(event=self.event).count()

        with (
            patch(
                "apps.scheduling.services.deliveries._enqueue_invitation_job",
                side_effect=RuntimeError("queue unavailable"),
            ),
            self.assertRaisesMessage(RuntimeError, "queue unavailable"),
        ):
            create_or_reuse_managed_participant_and_send(
                event=self.event,
                organizer=self.organizer,
                name="Rollback Person",
                email=email,
                idempotency_key=uuid.uuid4(),
            )

        self.assertFalse(ContactEmail.objects.filter(email_address=email).exists())
        self.assertFalse(Participant.objects.filter(event=self.event).exists())
        self.assertFalse(EventInvitation.objects.filter(event=self.event, email=email).exists())
        self.assertEqual(UserEvent.objects.filter(event=self.event).count(), baseline_user_events)
        self.assertFalse(EmailDeliveryRequest.objects.filter(event=self.event).exists())
        self.assertFalse(EmailDeliveryJob.objects.filter(event=self.event).exists())

    def test_visible_participant_is_a_persisted_idempotent_noop(self):
        invited = create_or_reuse_managed_participant_and_send(
            event=self.event,
            organizer=self.organizer,
            name="Existing Person",
            email="existing@example.com",
            idempotency_key=uuid.uuid4(),
        )
        key = uuid.uuid4()

        first = create_or_reuse_managed_participant_and_send(
            event=self.event,
            organizer=self.organizer,
            name="Existing Person",
            email="existing@example.com",
            idempotency_key=key,
        )
        replay = create_or_reuse_managed_participant_and_send(
            event=self.event,
            organizer=self.organizer,
            name="Existing Person",
            email="existing@example.com",
            idempotency_key=key,
        )

        self.assertFalse(first["participantCreated"])
        self.assertFalse(first["participantRestored"])
        self.assertEqual(first["deliveryResult"]["request"].recipient_count, 0)
        self.assertEqual(first["deliveryResult"]["request"].created_job_count, 0)
        self.assertFalse(first["deliveryResult"]["idempotent"])
        self.assertTrue(replay["deliveryResult"]["idempotent"])
        self.assertEqual(
            first["deliveryResult"]["request"].pk,
            replay["deliveryResult"]["request"].pk,
        )
        self.assertEqual(
            _latest_delivery_request(self.event)["id"],
            str(invited["deliveryResult"]["request"].pk),
        )
