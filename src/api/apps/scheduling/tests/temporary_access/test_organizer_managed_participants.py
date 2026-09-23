import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest import skipUnless
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core import mail
from django.db import connection, connections
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.authn.security.helpers import RateLimitDecision
from apps.authn.services.email.auth_email import resolve_login_identifier
from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest
from apps.mail.services import dispatch_due_email_jobs
from apps.scheduling.models import (
    Event,
    EventInvitation,
    Participant,
    TemporaryEventSession,
    UserEvent,
)
from apps.scheduling.permissions import has_event_invitation, verified_invitation_emails
from apps.scheduling.services.finalization import final_notification_recipients
from apps.scheduling.services.invitations import (
    enqueue_manual_reminders,
    mark_invitation_for_member,
    member_invitation_emails,
)
from apps.scheduling.services.temporary_access import request_temporary_access_code

ORGANIZER_EMAIL = "organizer@example.com"
NOT_OWNED_MESSAGE = "Use one of your own verified email addresses for a person you manage."
OWN_EMAIL_MESSAGE = (
    'That is one of your own addresses. Check "No email of their own" to add a person you manage.'
)


class OrganizerManagedParticipantTests(TestCase):
    def setUp(self):
        self.organizer = create_member(ORGANIZER_EMAIL, "Event", "Owner")
        self.organizer_client = APIClient()
        self.organizer_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(self.organizer)}")
        self.event = Event.objects.create(
            code="MANAGED1",
            name="Family planning",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            access_mode="open_link",
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )

    def add_person(self, name, *, email=ORGANIZER_EMAIL, key=None, **fields):
        return self.organizer_client.post(
            f"/events/participants/managed?code={self.event.code}",
            {"name": name, "email": email, "idempotencyKey": str(key or uuid.uuid4()), **fields},
            format="json",
        )

    def add_managed(self, name, **fields):
        return self.add_person(name, organizerManaged=True, **fields)

    def invite(self, email):
        return self.organizer_client.post(
            f"/events/invitations?code={self.event.code}",
            {"emails": [email], "message": "", "idempotencyKey": str(uuid.uuid4())},
            format="json",
        )

    def roster_rows(self, query=""):
        response = self.organizer_client.get(f"/events/participants?code={self.event.code}{query}")
        self.assertEqual(response.status_code, 200, response.data)
        return response.data["participants"]

    def assert_managed_row(self, row, *, name, phone=""):
        self.assertEqual(row["name"], name)
        self.assertEqual(row["email"], ORGANIZER_EMAIL)
        self.assertEqual(row["phone"], phone)
        self.assertEqual(row["invitationStatus"], "not_sent")
        self.assertEqual(row["accountAccess"], "temporary")
        self.assertTrue(row["organizerManaged"])
        self.assertTrue(row["canOrganizerEditAvailability"])

    def test_two_people_share_the_organizer_address_without_any_email(self):
        contact_count = ContactEmail.objects.count()
        first = self.add_managed("Grandma Ruth", phone="+1 (555) 123-4567")
        second = self.add_managed("Uncle Bob")
        self.assertEqual(first.status_code, 201, first.data)
        self.assertEqual(second.status_code, 201, second.data)

        self.assert_managed_row(
            first.data["participant"], name="Grandma Ruth", phone="+1 (555) 123-4567"
        )
        self.assert_managed_row(second.data["participant"], name="Uncle Bob")
        for response in (first, second):
            self.assertTrue(response.data["created"])
            self.assertFalse(response.data["restored"])
            self.assertTrue(response.data["memberCreated"])
            self.assertFalse(response.data["idempotent"])
            self.assertEqual(response.data["autoInvitedCount"], 0)
            self.assertEqual(response.data["deliveryRequest"]["recipientCount"], 0)
        member_ids = {first.data["participant"]["id"], second.data["participant"]["id"]}
        self.assertEqual(len(member_ids), 2)
        participants = Participant.objects.filter(event=self.event, organizer_managed=True)
        self.assertEqual(participants.count(), 2)
        self.assertEqual({str(item.member_id) for item in participants}, member_ids)
        self.assertEqual(
            set(participants.values_list("contact_email", flat=True)),
            {ORGANIZER_EMAIL},
        )

        self.assertEqual(ContactEmail.objects.count(), contact_count)
        Member = get_user_model()
        for member_id in member_ids:
            member = Member.objects.get(pk=member_id)
            self.assertEqual(member.email, "")
            self.assertEqual(member.access_level, Member.AccessLevel.TEMPORARY)
            self.assertTrue(member.is_active)
            self.assertFalse(member.has_usable_password())
            self.assertFalse(member.contact_emails.exists())
            self.assertTrue(
                UserEvent.objects.filter(
                    member=member,
                    event=self.event,
                    role="participant",
                ).exists()
            )

        self.assertEqual(EventInvitation.objects.filter(event=self.event).count(), 0)
        self.assertEqual(EmailDeliveryJob.objects.count(), 0)
        self.assertEqual(EmailDeliveryRequest.objects.filter(event=self.event).count(), 2)
        dispatch_due_email_jobs()
        self.assertEqual(len(mail.outbox), 0)

        rows = {row["name"]: row for row in self.roster_rows()}
        self.assertEqual(set(rows), {"Grandma Ruth", "Uncle Bob"})
        self.assert_managed_row(
            rows["Grandma Ruth"], name="Grandma Ruth", phone="+1 (555) 123-4567"
        )
        self.assert_managed_row(rows["Uncle Bob"], name="Uncle Bob")
        self.assertEqual({row["memberId"] for row in rows.values()}, member_ids)
        roster = self.organizer_client.get(f"/events/roster?code={self.event.code}")
        self.assertEqual(roster.status_code, 200)
        self.assertEqual(
            [
                (row["email"], row["phone"], row["organizerManaged"])
                for row in roster.data["participants"]
            ],
            [(ORGANIZER_EMAIL, "+1 (555) 123-4567", True), (ORGANIZER_EMAIL, "", True)],
        )

    def test_idempotent_replay_and_reuse_of_a_managed_person(self):
        key = uuid.uuid4()
        created = self.add_managed("Grandma Ruth", key=key, phone="555-123-4567")
        self.assertEqual(created.status_code, 201, created.data)
        participant_id = created.data["participant"]["id"]

        replay = self.add_managed("Grandma Ruth", key=key, phone="555-123-4567")
        self.assertEqual(replay.status_code, 200, replay.data)
        self.assertEqual(replay.data["participant"]["id"], participant_id)
        self.assertTrue(replay.data["idempotent"])
        self.assertFalse(replay.data["created"])
        self.assertFalse(replay.data["restored"])
        self.assertFalse(replay.data["memberCreated"])
        self.assertEqual(
            replay.data["deliveryRequest"]["id"],
            created.data["deliveryRequest"]["id"],
        )
        self.assertEqual(EmailDeliveryRequest.objects.filter(event=self.event).count(), 1)

        reused = self.add_managed("grandma ruth", phone="555-123-4567")
        self.assertEqual(reused.status_code, 200, reused.data)
        self.assertEqual(reused.data["participant"]["id"], participant_id)
        self.assertEqual(reused.data["participant"]["name"], "Grandma Ruth")
        self.assertFalse(reused.data["created"])
        self.assertFalse(reused.data["restored"])
        self.assertFalse(reused.data["idempotent"])
        self.assertEqual(EmailDeliveryRequest.objects.filter(event=self.event).count(), 2)
        self.assertEqual(Participant.objects.filter(event=self.event).count(), 1)

        for label, fields in (
            ("name", {"phone": "555-123-4567", "organizerManaged": True}),
            ("phone", {"phone": "555-123-9999", "organizerManaged": True}),
            ("flag", {"phone": "555-123-4567", "organizerManaged": False}),
        ):
            with self.subTest(label=label):
                name = "Grandma Ruthie" if label == "name" else "Grandma Ruth"
                conflict = self.add_person(name, key=key, **fields)
                self.assertEqual(conflict.status_code, 409, conflict.data)
                self.assertEqual(
                    conflict.data["error"],
                    "This idempotency key was already used with different participant details.",
                )
                self.assertNotIn("errorCode", conflict.data)
        self.assertEqual(Participant.objects.filter(event=self.event).count(), 1)

    def test_managed_person_requests_are_validated(self):
        ContactEmail.objects.create(
            member=self.organizer,
            email_address="alias@example.com",
            email_type="secondary",
            verified=False,
        )
        pending = create_member("pending@example.com", "Pending", "Account", contact_verified=False)
        member_count = get_user_model().objects.count()

        cases = [
            (
                "not owned",
                {"name": "Cousin", "email": "cousin@example.com", "organizerManaged": True},
                400,
                NOT_OWNED_MESSAGE,
                None,
            ),
            (
                "unverified own address",
                {"name": "Cousin", "email": "alias@example.com", "organizerManaged": True},
                400,
                NOT_OWNED_MESSAGE,
                None,
            ),
            (
                "non-boolean flag",
                {"name": "Cousin", "organizerManaged": "yes"},
                400,
                "organizerManaged must be true or false",
                None,
            ),
            (
                "invalid phone",
                {"name": "Cousin", "organizerManaged": True, "phone": "call me"},
                400,
                "Enter a valid phone number.",
                None,
            ),
            (
                "long phone",
                {"name": "Cousin", "organizerManaged": True, "phone": "1" * 33},
                400,
                "Phone is too long (max 32).",
                None,
            ),
            (
                "own verified address without the flag",
                {"name": "Cousin", "organizerManaged": False},
                409,
                OWN_EMAIL_MESSAGE,
                "organizer_own_email",
            ),
            (
                "own unverified address without the flag",
                {"name": "Cousin", "email": "alias@example.com"},
                409,
                OWN_EMAIL_MESSAGE,
                "organizer_own_email",
            ),
            (
                "unverified full account without the flag",
                {"name": "Cousin", "email": "pending@example.com", "organizerManaged": False},
                409,
                "This email belongs to an unverified full account.",
                None,
            ),
        ]
        for label, fields, status_code, message, error_code in cases:
            with self.subTest(label=label):
                response = self.add_person(fields.pop("name"), **fields)
                self.assertEqual(response.status_code, status_code, response.data)
                self.assertEqual(response.data["error"], message)
                if error_code:
                    self.assertEqual(response.data["errorCode"], error_code)
                else:
                    self.assertNotIn("errorCode", response.data)

        self.assertFalse(Participant.objects.filter(event=self.event).exists())
        self.assertFalse(EventInvitation.objects.filter(event=self.event).exists())
        self.assertEqual(get_user_model().objects.count(), member_count)
        self.assertTrue(get_user_model().objects.filter(pk=pending.pk).exists())

    def test_requests_without_the_new_keys_are_unchanged(self):
        created = self.add_person("Managed Person", email="managed@example.com")
        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(created.data["autoInvitedCount"], 1)
        self.assertFalse(created.data["participant"]["organizerManaged"])
        self.assertEqual(created.data["participant"]["phone"], "")
        self.assertEqual(created.data["participant"]["email"], "managed@example.com")
        self.assertEqual(created.data["participant"]["accountAccess"], "temporary")
        participant = Participant.objects.get(member_id=created.data["participant"]["id"])
        self.assertFalse(participant.organizer_managed)
        self.assertEqual(participant.contact_email, "")
        self.assertEqual(participant.contact_phone, "")
        self.assertEqual(participant.member.email, "managed@example.com")
        self.assertTrue(ContactEmail.objects.filter(member=participant.member).exists())
        self.assertEqual(EventInvitation.objects.filter(event=self.event).count(), 1)
        self.assertEqual(EmailDeliveryJob.objects.filter(event=self.event).count(), 1)

        explicit = self.add_person(
            "Phoned Person",
            email="phoned@example.com",
            phone=" 555 123 4567 ",
            organizerManaged=None,
        )
        self.assertEqual(explicit.status_code, 201, explicit.data)
        self.assertEqual(explicit.data["participant"]["phone"], "555 123 4567")
        self.assertFalse(explicit.data["participant"]["organizerManaged"])
        phoned = Participant.objects.get(member_id=explicit.data["participant"]["id"])
        self.assertEqual(phoned.contact_phone, "555 123 4567")
        self.assertFalse(phoned.organizer_managed)
        self.assertEqual(EventInvitation.objects.filter(event=self.event).count(), 2)
        row = next(row for row in self.roster_rows() if row["name"] == "Phoned Person")
        self.assertEqual(row["phone"], "555 123 4567")
        self.assertEqual(row["email"], "phoned@example.com")
        self.assertFalse(row["organizerManaged"])

    def test_organizer_enters_a_schedule_without_touching_invitations(self):
        invited = self.invite("third@example.com")
        self.assertEqual(invited.status_code, 202, invited.data)
        own_invitation = EventInvitation.objects.create(
            event=self.event,
            email=ORGANIZER_EMAIL,
            member=self.organizer,
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        before = list(
            EventInvitation.objects.filter(event=self.event)
            .order_by("email")
            .values("email", "status", "joined_at", "submitted_at", "draft_saved_at")
        )
        self.assertEqual(len(before), 2)

        created = self.add_managed("Grandma Ruth")
        self.assertEqual(created.status_code, 201, created.data)
        member_id = created.data["participant"]["id"]
        managed_member = get_user_model().objects.get(pk=member_id)
        # The organizer's own sent invitation must not colour the managed row.
        self.assert_managed_row(created.data["participant"], name="Grandma Ruth")
        fresh_row = next(row for row in self.roster_rows() if row["memberId"] == member_id)
        self.assertEqual(fresh_row["invitationStatus"], "not_sent")

        saved = self.organizer_client.put(
            f"/events/participants/update?code={self.event.code}&participantId={member_id}",
            {
                "availabilityInperson": [1, 1],
                "availabilityVirtual": [0, 1],
                "submitted": 1,
                "expectedVersion": created.data["participant"]["version"],
            },
            format="json",
        )
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual(saved.data["participant"]["submitted"], 1)
        # The Invitation badge only describes email: nothing was ever sent.
        self.assertEqual(saved.data["participant"]["invitationStatus"], "not_sent")
        self.assertEqual(saved.data["participant"]["email"], ORGANIZER_EMAIL)
        self.assertTrue(saved.data["participant"]["organizerManaged"])
        participant = Participant.objects.get(member_id=member_id)
        self.assertTrue(participant.submitted)
        self.assertEqual(participant.availability_inperson, [1, 1])
        self.assertEqual(participant.version, created.data["participant"]["version"] + 1)
        row = next(row for row in self.roster_rows() if row["memberId"] == member_id)
        self.assertEqual(row["invitationStatus"], "not_sent")
        self.assertTrue(row["submitted"])

        mark_invitation_for_member(event=self.event, member=managed_member, submitted=True)
        self.assertEqual(member_invitation_emails(managed_member), set())
        after = list(
            EventInvitation.objects.filter(event=self.event)
            .order_by("email")
            .values("email", "status", "joined_at", "submitted_at", "draft_saved_at")
        )
        self.assertEqual(after, before)
        own_invitation.refresh_from_db()
        self.assertEqual(own_invitation.status, EventInvitation.Status.INVITED)
        self.assertIsNone(own_invitation.submitted_at)
        self.assertEqual(EventInvitation.objects.filter(event=self.event).count(), 2)

    def test_shared_address_never_resolves_to_a_managed_person(self):
        created = self.add_managed("Grandma Ruth")
        self.assertEqual(created.status_code, 201, created.data)
        managed_member = get_user_model().objects.get(pk=created.data["participant"]["id"])
        ContactEmail.objects.create(
            member=self.organizer,
            email_address="alias@example.com",
            email_type="secondary",
            verified=False,
        )

        self.assertEqual(resolve_login_identifier(ORGANIZER_EMAIL).member, self.organizer)
        self.assertIsNone(resolve_login_identifier("alias@example.com"))
        self.assertFalse(has_event_invitation(self.event, managed_member))
        self.assertEqual(verified_invitation_emails(managed_member), set())
        self.assertEqual(member_invitation_emails(managed_member), set())

        own_invitation = EventInvitation.objects.create(
            event=self.event,
            email=ORGANIZER_EMAIL,
            member=self.organizer,
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        self.assertFalse(
            request_temporary_access_code(
                event_code=self.event.code,
                access_token=own_invitation.access_token,
            )
        )
        requested = APIClient().post(
            "/events/temp-access/request-code",
            {"code": self.event.code, "invitationToken": str(own_invitation.access_token)},
            format="json",
        )
        self.assertEqual(requested.status_code, 202)
        self.assertFalse(
            EmailAuthChallenge.objects.filter(
                purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS
            ).exists()
        )
        self.assertFalse(TemporaryEventSession.objects.exists())
        self.assertEqual(len(mail.outbox), 0)

    def test_organizer_joins_alongside_managed_people(self):
        self.assertEqual(self.add_managed("Grandma Ruth").status_code, 201)
        joined = self.organizer_client.post(
            f"/events/participants?code={self.event.code}",
            {},
            format="json",
        )
        self.assertEqual(joined.status_code, 201, joined.data)
        self.assertEqual(joined.data["participant"]["id"], str(self.organizer.pk))
        self.assertEqual(Participant.objects.filter(event=self.event).count(), 2)

        rows = {row["name"]: row for row in self.roster_rows()}
        self.assert_managed_row(rows["Grandma Ruth"], name="Grandma Ruth")
        own = rows["Event Owner"]
        self.assertEqual(own["memberId"], str(self.organizer.pk))
        self.assertEqual(own["email"], ORGANIZER_EMAIL)
        self.assertEqual(own["accountAccess"], "full")
        self.assertFalse(own["organizerManaged"])
        self.assertFalse(own["canOrganizerEditAvailability"])
        self.assertIsNotNone(
            Participant.objects.get(event=self.event, member=self.organizer).response_claimed_at
        )

    def test_final_notifications_and_reminders_skip_managed_people(self):
        self.assertEqual(self.add_managed("Grandma Ruth").status_code, 201)
        third = self.add_person("Third Person", email="third@example.com")
        self.assertEqual(third.status_code, 201, third.data)
        dispatch_due_email_jobs()
        self.assertEqual([message.to for message in mail.outbox], [["third@example.com"]])
        self.assertIsNotNone(
            EventInvitation.objects.get(event=self.event, email="third@example.com").first_sent_at
        )

        self.assertEqual(final_notification_recipients(self.event), ["third@example.com"])
        reminders = enqueue_manual_reminders(
            event=self.event,
            requested_by=self.organizer,
            idempotency_key=uuid.uuid4(),
        )
        self.assertEqual(reminders["request"].recipient_count, 1)
        self.assertEqual([job.recipient for job in reminders["jobs"]], ["third@example.com"])
        dispatch_due_email_jobs()
        self.assertEqual(len(mail.outbox), 2)
        self.assertNotIn([ORGANIZER_EMAIL], [message.to for message in mail.outbox])

    def test_hidden_managed_people_are_restored_by_re_adding_or_unhiding(self):
        created = self.add_managed("Grandma Ruth", phone="555-123-4567")
        self.assertEqual(created.status_code, 201, created.data)
        member_id = created.data["participant"]["id"]
        version = created.data["participant"]["version"]
        member_count = get_user_model().objects.count()
        update_url = f"/events/participants/update?code={self.event.code}&participantId={member_id}"

        hidden = self.organizer_client.delete(update_url)
        self.assertEqual(hidden.status_code, 200, hidden.data)
        self.assertTrue(Participant.objects.get(member_id=member_id).hidden)
        self.assertEqual([row["memberId"] for row in self.roster_rows()], [])

        restored = self.add_managed("GRANDMA RUTH")
        self.assertEqual(restored.status_code, 200, restored.data)
        self.assertEqual(restored.data["participant"]["id"], member_id)
        self.assertTrue(restored.data["restored"])
        self.assertFalse(restored.data["created"])
        self.assertFalse(restored.data["memberCreated"])
        self.assertEqual(restored.data["participant"]["name"], "GRANDMA RUTH")
        self.assertEqual(restored.data["participant"]["phone"], "555-123-4567")
        self.assertEqual(restored.data["participant"]["hidden"], 0)
        self.assertEqual(restored.data["participant"]["version"], version + 2)
        self.assertEqual(get_user_model().objects.count(), member_count)
        self.assertEqual([row["memberId"] for row in self.roster_rows()], [member_id])

        self.assertEqual(self.organizer_client.delete(update_url).status_code, 200)
        unhidden = self.organizer_client.put(f"{update_url.replace('/update?', '/update/unhide?')}")
        self.assertEqual(unhidden.status_code, 200, unhidden.data)
        self.assertEqual(unhidden.data["participant"]["hidden"], 0)
        self.assertEqual(unhidden.data["participant"]["version"], version + 4)

        self.assertEqual(self.organizer_client.delete(update_url).status_code, 200)
        same_name = self.add_managed("GRANDMA RUTH")
        self.assertEqual(same_name.status_code, 200, same_name.data)
        self.assertTrue(same_name.data["restored"])
        self.assertEqual(same_name.data["participant"]["version"], version + 6)
        self.assertEqual(Participant.objects.filter(event=self.event).count(), 1)
        self.assertEqual(EventInvitation.objects.filter(event=self.event).count(), 0)

    def test_roster_rebuild_removes_managed_people_and_their_members(self):
        first = self.add_managed("Grandma Ruth")
        second = self.add_managed("Uncle Bob")
        managed_member_ids = [first.data["participant"]["id"], second.data["participant"]["id"]]
        self.assertEqual(get_user_model().objects.filter(pk__in=managed_member_ids).count(), 2)

        preview = self.organizer_client.post(
            f"/events/roster-imports?code={self.event.code}",
            {
                "sourceType": "paste",
                "pastedText": "name,email\nReplacement,replacement@example.com",
            },
            format="json",
        )
        self.assertEqual(preview.status_code, 201, preview.data)
        rebuilt = self.organizer_client.post(
            f"/events/roster-imports/{preview.data['import']['id']}/commit?code={self.event.code}",
            {
                "mode": "rebuild",
                "idempotencyKey": str(uuid.uuid4()),
                "confirmationCode": self.event.code,
            },
            format="json",
        )
        self.assertEqual(rebuilt.status_code, 201, rebuilt.data)
        self.assertEqual(
            list(self.event.participants.values_list("participant_name", flat=True)),
            ["Replacement"],
        )
        self.assertFalse(get_user_model().objects.filter(pk__in=managed_member_ids).exists())
        self.assertTrue(get_user_model().objects.filter(pk=self.organizer.pk).exists())

    def test_event_deletion_removes_the_members_behind_managed_people(self):
        managed_member_id = self.add_managed("Grandma Ruth").data["participant"]["id"]
        invited = create_member("third@example.com", "Third", "Person")
        self.assertEqual(
            self.add_person("Third Person", email="third@example.com").status_code, 201
        )
        self.event.refresh_from_db()

        deleted = self.organizer_client.delete(
            f"/events?code={self.event.code}",
            {
                "expectedVersion": self.event.version,
                "idempotencyKey": str(uuid.uuid4()),
                "confirmation": self.event.code,
            },
            format="json",
        )
        self.assertEqual(deleted.status_code, 200, deleted.data)
        self.assertFalse(Event.objects.filter(pk=self.event.pk).exists())
        Member = get_user_model()
        self.assertFalse(Member.objects.filter(pk=managed_member_id).exists())
        # Real people keep their accounts; only the identity-less backing member goes.
        self.assertTrue(Member.objects.filter(pk=invited.pk).exists())
        self.assertTrue(Member.objects.filter(pk=self.organizer.pk).exists())

    def test_managed_people_do_not_consume_the_invitation_recipient_quota(self):
        quota_denied = RateLimitDecision(allowed=False, retry_after=9)
        with patch(
            "apps.scheduling.views.participants.managed.consume_request_rate_limit",
            return_value=quota_denied,
        ) as quota:
            added = self.add_managed("Grandma Ruth")
            self.assertEqual(added.status_code, 201, added.data)
            quota.assert_not_called()
            throttled = self.add_person("Third Person", email="third@example.com")
        self.assertEqual(throttled.status_code, 429)
        quota.assert_called_once()

    def test_patch_edits_the_phone_of_a_roster_row(self):
        created = self.add_managed("Grandma Ruth")
        self.assertEqual(created.status_code, 201, created.data)
        participant = Participant.objects.get(member_id=created.data["participant"]["id"])
        version = participant.version
        url = f"/events/roster/{participant.pk}?code={self.event.code}"

        patched = self.organizer_client.patch(
            url,
            {"phone": "+1 (555) 123-4567", "expectedVersion": version},
            format="json",
        )
        self.assertEqual(patched.status_code, 200, patched.data)
        self.assertEqual(patched.data["participant"]["phone"], "+1 (555) 123-4567")
        self.assertEqual(patched.data["participant"]["version"], version + 1)
        participant.refresh_from_db()
        self.assertEqual(participant.contact_phone, "+1 (555) 123-4567")

        for label, phone, message in (
            ("invalid", "call me", "Enter a valid phone number."),
            ("too long", "1" * 33, "Phone is too long (max 32)."),
        ):
            with self.subTest(label=label):
                rejected = self.organizer_client.patch(
                    url,
                    {"phone": phone, "expectedVersion": version + 1},
                    format="json",
                )
                self.assertEqual(rejected.status_code, 400, rejected.data)
                self.assertEqual(rejected.data["error"], message)
        participant.refresh_from_db()
        self.assertEqual(participant.contact_phone, "+1 (555) 123-4567")
        self.assertEqual(participant.version, version + 1)

        unchanged = self.organizer_client.patch(
            url,
            {"phone": " +1 (555) 123-4567 ", "expectedVersion": version + 1},
            format="json",
        )
        self.assertEqual(unchanged.status_code, 200, unchanged.data)
        self.assertEqual(unchanged.data["participant"]["version"], version + 1)

        cleared = self.organizer_client.patch(
            url,
            {"phone": "", "expectedVersion": version + 1},
            format="json",
        )
        self.assertEqual(cleared.status_code, 200, cleared.data)
        self.assertEqual(cleared.data["participant"]["phone"], "")
        self.assertEqual(cleared.data["participant"]["version"], version + 2)
        participant.refresh_from_db()
        self.assertEqual(participant.contact_phone, "")

    def test_roster_search_and_filters_see_managed_rows(self):
        self.assertEqual(
            self.add_managed("Grandma Ruth", phone="+1 (555) 123-4567").status_code, 201
        )
        self.assertEqual(self.add_managed("Uncle Bob").status_code, 201)
        joined = self.organizer_client.post(
            f"/events/participants?code={self.event.code}",
            {},
            format="json",
        )
        self.assertEqual(joined.status_code, 201)

        self.assertEqual(
            [row["name"] for row in self.roster_rows("&search=555")],
            ["Grandma Ruth"],
        )
        self.assertEqual(
            [row["name"] for row in self.roster_rows("&search=organizer@")],
            ["Grandma Ruth", "Uncle Bob", "Event Owner"],
        )
        roster = self.organizer_client.get(f"/events/roster?code={self.event.code}&search=123-4567")
        self.assertEqual(roster.status_code, 200, roster.data)
        self.assertEqual([row["name"] for row in roster.data["participants"]], ["Grandma Ruth"])
        self.assertEqual(
            [row["name"] for row in self.roster_rows("&invitationStatus=not_sent")],
            ["Grandma Ruth", "Uncle Bob", "Event Owner"],
        )
        self.assertEqual(
            [row["name"] for row in self.roster_rows("&accountAccess=temporary")],
            ["Grandma Ruth", "Uncle Bob"],
        )

        bulk = self.organizer_client.patch(
            f"/events/roster/bulk?code={self.event.code}",
            {
                "filter": {"accountAccess": "temporary"},
                "updates": {"group": "Family"},
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertEqual(bulk.status_code, 200, bulk.data)
        self.assertEqual(bulk.data["matchedCount"], 2)
        self.assertEqual(bulk.data["updatedCount"], 2)
        self.assertEqual(
            sorted(
                Participant.objects.filter(event=self.event, groups__name="Family").values_list(
                    "participant_name", flat=True
                )
            ),
            ["Grandma Ruth", "Uncle Bob"],
        )

    def test_managed_people_respect_the_participant_limit_and_event_locks(self):
        with override_settings(EVENT_MAX_PARTICIPANTS=1):
            self.assertEqual(self.add_managed("Grandma Ruth").status_code, 201)
            capped = self.add_managed("Uncle Bob")
            self.assertEqual(capped.status_code, 409, capped.data)
            self.assertEqual(capped.data["error"], "An event can have at most 1 participants.")
            self.assertNotIn("errorCode", capped.data)
            self.assertEqual(self.add_managed("Grandma Ruth").status_code, 200)
        self.assertEqual(Participant.objects.filter(event=self.event).count(), 1)

        self.event.status = Event.Status.CLOSED
        self.event.save(update_fields=["status", "updated_at"])
        closed = self.add_managed("Uncle Bob")
        self.assertEqual(closed.status_code, 409, closed.data)
        self.assertEqual(closed.data["error"], "Responses cannot change while the event is closed.")
        self.event.status = Event.Status.ACTIVE
        self.event.save(update_fields=["status", "updated_at"])

        outsider = create_member("outsider@example.com", "Other", "Person")
        outsider_client = APIClient()
        outsider_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(outsider)}")
        forbidden = outsider_client.post(
            f"/events/participants/managed?code={self.event.code}",
            {
                "name": "Uncle Bob",
                "email": "outsider@example.com",
                "idempotencyKey": str(uuid.uuid4()),
                "organizerManaged": True,
            },
            format="json",
        )
        self.assertEqual(forbidden.status_code, 403, forbidden.data)
        self.assertEqual(
            forbidden.data["error"],
            "Only the organizer can create managed participants.",
        )
        self.assertEqual(Participant.objects.filter(event=self.event).count(), 1)


@skipUnless(connection.vendor == "postgresql", "PostgreSQL row-lock behavior")
class OrganizerManagedDoubleSubmitTests(TransactionTestCase):
    def setUp(self):
        super().setUp()
        self.organizer = create_member(ORGANIZER_EMAIL, "Event", "Owner")
        self.event = Event.objects.create(
            code="MANAGED2",
            name="Family planning",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            access_mode="open_link",
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )

    def test_the_same_key_submitted_twice_at_once_records_one_receipt(self):
        key = str(uuid.uuid4())

        def submit():
            client = APIClient()
            client.force_authenticate(user=self.organizer)
            try:
                return client.post(
                    f"/events/participants/managed?code={self.event.code}",
                    {
                        "name": "Grandma Ruth",
                        "email": ORGANIZER_EMAIL,
                        "idempotencyKey": key,
                        "organizerManaged": True,
                    },
                    format="json",
                )
            finally:
                connections["default"].close()

        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(lambda _: submit(), range(2)))

        self.assertEqual(sorted(response.status_code for response in responses), [200, 201])
        self.assertEqual(
            {response.data["participant"]["id"] for response in responses},
            {str(Participant.objects.get(event=self.event).member_id)},
        )
        self.assertEqual(
            [response.data["idempotent"] for response in responses if response.status_code == 200],
            [True],
        )
        self.assertEqual(EmailDeliveryRequest.objects.filter(event=self.event).count(), 1)
        self.assertEqual(EventInvitation.objects.filter(event=self.event).count(), 0)
