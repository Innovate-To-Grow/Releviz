import hashlib
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest import skipUnless

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import connection, connections, transaction
from django.test import TransactionTestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member
from apps.scheduling.models import (
    Event,
    EventInvitation,
    Participant,
    ScheduleEditRecord,
    TemporaryEventSession,
)


@skipUnless(connection.vendor == "postgresql", "PostgreSQL row-lock behavior")
class TemporaryScheduleLockOrderTests(TransactionTestCase):
    def setUp(self):
        super().setUp()
        self.organizer = create_member("lock-owner@example.com", "Lock", "Owner")
        self.temporary = create_member(
            "lock-temp@example.com",
            "Lock",
            "Temporary",
            access_level="temporary",
            contact_verified=False,
        )
        self.temporary.set_unusable_password()
        self.temporary.save(update_fields=["password"])
        self.event = Event.objects.create(
            code="TMPLOCK1",
            name="Temporary lock order",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        self.participant = Participant.objects.create(
            event=self.event,
            member=self.temporary,
            participant_name="Lock Temporary",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        self.invitation = EventInvitation.objects.create(
            event=self.event,
            member=self.temporary,
            invited_by=self.organizer,
            email="lock-temp@example.com",
            first_sent_at=timezone.now(),
            last_sent_at=timezone.now(),
        )
        self.secret = "temporary-lock-secret"
        self.session = TemporaryEventSession.objects.create(
            member=self.temporary,
            participant=self.participant,
            invitation=self.invitation,
            secret_hash=hashlib.sha256(self.secret.encode()).hexdigest(),
            expires_at=timezone.now() + timedelta(days=7),
        )

    def run_while_member_row_is_locked(self, callback, member=None):
        def worker():
            worker_connection = connections["default"]
            try:
                with worker_connection.cursor() as cursor:
                    cursor.execute("SET lock_timeout = '750ms'")
                return callback()
            finally:
                worker_connection.close()

        Member = get_user_model()
        with transaction.atomic():
            Member.objects.select_for_update().get(pk=(member or self.temporary).pk)
            with ThreadPoolExecutor(max_workers=1) as executor:
                return executor.submit(worker).result(timeout=5)

    def test_organizer_schedule_update_does_not_lock_member_row(self):
        def update_schedule():
            client = APIClient()
            client.force_authenticate(user=self.organizer)
            return client.put(
                (
                    f"/events/participants/update?code={self.event.code}"
                    f"&participantId={self.temporary.pk}"
                ),
                {
                    "availabilityInperson": [1, 0],
                    "submitted": 0,
                    "expectedVersion": self.participant.version,
                },
                format="json",
            )

        response = self.run_while_member_row_is_locked(update_schedule)

        self.assertEqual(response.status_code, 200, response.data)
        self.participant.refresh_from_db()
        self.assertEqual(self.participant.availability_inperson, [1, 0])

    def test_temporary_schedule_update_does_not_lock_member_row(self):
        def update_schedule():
            client = APIClient()
            client.cookies[settings.TEMP_EVENT_COOKIE_NAME] = f"{self.session.pk}.{self.secret}"
            return client.put(
                f"/events/temp-access/participant?code={self.event.code}",
                {
                    "availabilityVirtual": [1, 0],
                    "expectedVersion": self.participant.version,
                },
                format="json",
                HTTP_ORIGIN="http://testserver",
            )

        response = self.run_while_member_row_is_locked(update_schedule)

        self.assertEqual(response.status_code, 200, response.data)
        self.participant.refresh_from_db()
        self.assertEqual(self.participant.availability_virtual, [1, 0])
        edit = ScheduleEditRecord.objects.get(participant=self.participant)
        self.assertIsNone(edit.actor)
        self.assertEqual(edit.actor_identifier, self.temporary.pk)

    def unclaimed_full_account(self):
        """An organizer-added full account: linked invitation, no claim yet."""

        full = create_member("lock-full@example.com", "Lock", "Full")
        participant = Participant.objects.create(
            event=self.event,
            member=full,
            participant_name="Lock Full",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        EventInvitation.objects.create(
            event=self.event,
            member=full,
            invited_by=self.organizer,
            email="lock-full@example.com",
        )
        return full, participant

    def put_schedule(self, user, member, participant, availability):
        client = APIClient()
        client.force_authenticate(user=user)
        return client.put(
            f"/events/participants/update?code={self.event.code}&participantId={member.pk}",
            {
                "availabilityInperson": availability,
                "submitted": 0,
                "expectedVersion": participant.version,
            },
            format="json",
        )

    def test_organizer_entry_for_unclaimed_full_account_does_not_lock_member_row(self):
        full, participant = self.unclaimed_full_account()

        response = self.run_while_member_row_is_locked(
            lambda: self.put_schedule(self.organizer, full, participant, [1, 0]),
            member=full,
        )

        self.assertEqual(response.status_code, 200, response.data)
        participant.refresh_from_db()
        self.assertEqual(participant.availability_inperson, [1, 0])
        self.assertIsNone(participant.response_claimed_at)
        invitation = EventInvitation.objects.get(event=self.event, member=full)
        self.assertEqual(invitation.status, EventInvitation.Status.DRAFT_SAVED)
        self.assertIsNone(invitation.accepted_at)

    def test_first_self_write_claims_without_locking_member_row(self):
        full, participant = self.unclaimed_full_account()
        stale_version = participant.version
        entered = self.put_schedule(self.organizer, full, participant, [1, 0])
        self.assertEqual(entered.status_code, 200, entered.data)
        participant.version = stale_version

        # A stale self write only claims and accepts before its 409. A saved edit
        # always share-locks a full account's own Member row at commit through the
        # edit record's actor, so the claim itself is what is checked here.
        response = self.run_while_member_row_is_locked(
            lambda: self.put_schedule(full, full, participant, [0, 1]),
            member=full,
        )

        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(response.data["errorCode"], "participant_version_conflict")
        participant.refresh_from_db()
        self.assertIsNotNone(participant.response_claimed_at)
        self.assertEqual(participant.availability_inperson, [1, 0])
        self.assertIsNotNone(EventInvitation.objects.get(event=self.event, member=full).accepted_at)

    def test_organizer_entry_waits_for_a_committed_claim_and_is_denied(self):
        full, participant = self.unclaimed_full_account()

        def organizer_entry():
            worker_connection = connections["default"]
            try:
                return self.put_schedule(self.organizer, full, participant, [1, 1])
            finally:
                worker_connection.close()

        with ThreadPoolExecutor(max_workers=1) as executor:
            with transaction.atomic():
                claimed = Participant.objects.select_for_update().get(pk=participant.pk)
                claimed.response_claimed_at = timezone.now()
                claimed.save(update_fields=["response_claimed_at", "updated_at"])
                pending = executor.submit(organizer_entry)
                deadline = time.monotonic() + 5
                with connection.cursor() as cursor:
                    while time.monotonic() < deadline:
                        # Activity is snapshotted per transaction; read it fresh each time.
                        cursor.execute("SELECT pg_stat_clear_snapshot()")
                        cursor.execute(
                            "SELECT count(*) FROM pg_stat_activity "
                            "WHERE datname = current_database() AND wait_event_type = 'Lock'"
                        )
                        if cursor.fetchone()[0]:
                            break
                        time.sleep(0.02)
                    else:
                        self.fail("The organizer request never waited on the participant row.")
            response = pending.result(timeout=5)

        self.assertEqual(response.status_code, 403, response.data)
        self.assertEqual(response.data["errorCode"], "organizer_edit_participant_owned")
        participant.refresh_from_db()
        self.assertEqual(participant.availability_inperson, [0, 0])
        self.assertFalse(ScheduleEditRecord.objects.filter(participant=participant).exists())

    def test_upgrade_claims_and_renames_without_locking_event_row(self):
        from types import SimpleNamespace

        from apps.authn.models import EmailAuthChallenge
        from apps.authn.views.auth import email_code

        Participant.objects.filter(pk=self.participant.pk).update(participant_name="Label")
        challenge = SimpleNamespace(
            member_id=self.temporary.pk,
            target_email="lock-temp@example.com",
            purpose=EmailAuthChallenge.Purpose.REGISTER,
        )

        def upgrade():
            worker_connection = connections["default"]
            try:
                with worker_connection.cursor() as cursor:
                    cursor.execute("SET lock_timeout = '750ms'")
                with transaction.atomic():
                    return email_code._complete_registration(challenge)
            finally:
                worker_connection.close()

        with transaction.atomic():
            Event.objects.select_for_update().get(pk=self.event.pk)
            with ThreadPoolExecutor(max_workers=1) as executor:
                payload = executor.submit(upgrade).result(timeout=5)

        self.assertEqual(payload["message"], "Email verified. Registration successful.")
        self.participant.refresh_from_db()
        self.assertEqual(self.participant.participant_name, "Lock Temporary")
        self.assertIsNotNone(self.participant.response_claimed_at)
