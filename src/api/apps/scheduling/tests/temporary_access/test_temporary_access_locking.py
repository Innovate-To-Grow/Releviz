import hashlib
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

    def run_while_member_row_is_locked(self, callback):
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
            Member.objects.select_for_update().get(pk=self.temporary.pk)
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
