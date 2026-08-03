from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail
from apps.authn.tests.helpers import create_member
from apps.scheduling.models import (
    Event,
    EventInvitation,
    Participant,
    TemporaryEventSession,
    UserEvent,
)
from apps.scheduling.services import (
    ManagedParticipantError,
    create_or_reuse_managed_participant,
)
from apps.scheduling.utils import api_participant, default_availability


class TemporaryAccountCoverageTests(TestCase):
    def setUp(self):
        self.organizer = create_member("owner@example.com", "Event", "Owner")
        self.outsider = create_member("outsider@example.com", "Other", "Member")
        self.event = self.create_event("COVER001")

    def create_event(self, code, *, status=Event.Status.OPEN):
        return Event.objects.create(
            code=code,
            name="Coverage planning",
            organizer=self.organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            status=status,
        )

    def test_managed_participant_rejects_permission_lock_and_invalid_identity_inputs(self):
        cases = [
            (
                "non-organizer",
                self.event,
                self.outsider,
                "Managed Person",
                "managed@example.com",
                403,
                "Only the organizer can create managed participants.",
            ),
            (
                "closed event",
                self.create_event("COVER002", status=Event.Status.CLOSED),
                self.organizer,
                "Managed Person",
                "managed@example.com",
                409,
                "Responses cannot change while the event is closed.",
            ),
            (
                "missing name",
                self.event,
                self.organizer,
                "   ",
                "managed@example.com",
                400,
                "Name is required.",
            ),
            (
                "long name",
                self.event,
                self.organizer,
                "x" * 101,
                "managed@example.com",
                400,
                "Name is too long (max 100).",
            ),
            (
                "long email",
                self.event,
                self.organizer,
                "Managed Person",
                f"{'x' * 250}@x.com",
                400,
                "Email is too long (max 254).",
            ),
            (
                "invalid email",
                self.event,
                self.organizer,
                "Managed Person",
                "not-an-email",
                400,
                "Enter a valid email address.",
            ),
        ]

        for label, event, organizer, name, email, status_code, message in cases:
            with self.subTest(label=label):
                with self.assertRaises(ManagedParticipantError) as caught:
                    create_or_reuse_managed_participant(
                        event=event,
                        organizer=organizer,
                        name=name,
                        email=email,
                    )
                self.assertEqual(caught.exception.status_code, status_code)
                self.assertEqual(str(caught.exception), message)

    def test_existing_orphan_contact_is_safely_claimed_by_a_new_temporary_member(self):
        email = "direct-orphan@example.com"
        contact = ContactEmail.objects.create(
            email_address=email,
            member=None,
            email_type="other",
            verified=True,
        )

        result = create_or_reuse_managed_participant(
            event=self.event,
            organizer=self.organizer,
            name="  Orphan Person  ",
            email=" DIRECT-ORPHAN@EXAMPLE.COM ",
        )

        contact.refresh_from_db()
        member = result["participant"].member
        self.assertTrue(result["memberCreated"])
        self.assertEqual(contact.member_id, member.pk)
        self.assertEqual(contact.email_type, "primary")
        self.assertFalse(contact.verified)
        self.assertEqual(member.email, email)
        self.assertEqual(member.first_name, "Orphan Person")
        self.assertEqual(member.access_level, member.AccessLevel.TEMPORARY)
        self.assertTrue(member.is_active)
        self.assertFalse(member.has_usable_password())
        self.assertEqual(result["participant"].participant_name, "Orphan Person")
        self.assertTrue(
            UserEvent.objects.filter(
                member=member,
                event=self.event,
                role="participant",
            ).exists()
        )
        invitation = EventInvitation.objects.get(event=self.event, email=email)
        self.assertEqual(invitation.member_id, member.pk)
        self.assertEqual(invitation.invited_by_id, self.organizer.pk)
        self.assertIsNone(invitation.first_sent_at)

    def test_contact_created_during_lookup_race_is_attached_when_orphaned(self):
        email = "orphan-race@example.com"

        def create_racing_orphan(*, email_address, defaults):
            contact = ContactEmail.objects.create(
                email_address=email_address,
                member=None,
                email_type="other",
                verified=True,
            )
            return contact, False

        with patch.object(
            ContactEmail.objects,
            "get_or_create",
            side_effect=create_racing_orphan,
        ):
            result = create_or_reuse_managed_participant(
                event=self.event,
                organizer=self.organizer,
                name="Race Winner",
                email=email,
            )

        contact = ContactEmail.objects.get(email_address=email)
        self.assertEqual(contact.member_id, result["participant"].member_id)
        self.assertEqual(contact.email_type, "primary")
        self.assertFalse(contact.verified)
        self.assertTrue(result["memberCreated"])

    def test_contact_created_during_lookup_race_reuses_its_existing_member(self):
        Member = get_user_model()
        email = "member-race@example.com"
        race_winner = Member.objects.create_user(
            email=email,
            first_name="Existing",
            is_active=True,
            access_level="temporary",
        )

        def create_racing_contact(*, email_address, defaults):
            contact = ContactEmail.objects.create(
                email_address=email_address,
                member=race_winner,
                email_type="primary",
                verified=False,
            )
            return contact, False

        with patch.object(
            ContactEmail.objects,
            "get_or_create",
            side_effect=create_racing_contact,
        ):
            result = create_or_reuse_managed_participant(
                event=self.event,
                organizer=self.organizer,
                name="Race Participant",
                email=email,
            )

        self.assertEqual(result["participant"].member_id, race_winner.pk)
        self.assertFalse(result["memberCreated"])
        self.assertEqual(Member.objects.filter(email=email).count(), 1)

    def test_unverified_full_contacts_cannot_be_bound_as_managed_participants(self):
        Member = get_user_model()
        secondary_owner = create_member("secondary-owner@example.com", "Secondary", "Owner")
        unverified_secondary = ContactEmail.objects.create(
            member=secondary_owner,
            email_address="unverified-secondary@example.com",
            email_type="secondary",
            verified=False,
        )
        pending_primary_owner = Member.objects.create_user(
            email="pending-primary@example.com",
            first_name="Pending",
            is_active=False,
            access_level="full",
        )
        pending_primary = ContactEmail.objects.create(
            member=pending_primary_owner,
            email_address="pending-primary@example.com",
            email_type="primary",
            verified=False,
        )

        for label, contact in (
            ("unverified secondary", unverified_secondary),
            ("pending primary", pending_primary),
        ):
            with self.subTest(label=label):
                model_counts = {
                    "members": Member.objects.count(),
                    "contacts": ContactEmail.objects.count(),
                    "participants": Participant.objects.filter(event=self.event).count(),
                    "user_events": UserEvent.objects.filter(event=self.event).count(),
                    "invitations": EventInvitation.objects.filter(event=self.event).count(),
                }
                member_snapshot = {
                    "email": contact.member.email,
                    "first_name": contact.member.first_name,
                    "last_name": contact.member.last_name,
                    "is_active": contact.member.is_active,
                    "access_level": contact.member.access_level,
                    "password": contact.member.password,
                }
                contact_snapshot = {
                    "member_id": contact.member_id,
                    "email_type": contact.email_type,
                    "verified": contact.verified,
                }

                with self.assertRaises(ManagedParticipantError) as caught:
                    create_or_reuse_managed_participant(
                        event=self.event,
                        organizer=self.organizer,
                        name="Wrongly bound person",
                        email=contact.email_address,
                    )

                self.assertEqual(caught.exception.status_code, 409)
                self.assertEqual(
                    str(caught.exception),
                    "Unable to create a participant with this email address.",
                )
                self.assertFalse(
                    Participant.objects.filter(
                        event=self.event,
                        member_id=contact.member_id,
                    ).exists()
                )
                self.assertFalse(
                    UserEvent.objects.filter(event=self.event, member_id=contact.member_id).exists()
                )
                self.assertFalse(
                    EventInvitation.objects.filter(
                        event=self.event,
                        email=contact.email_address,
                    ).exists()
                )
                contact.refresh_from_db()
                contact.member.refresh_from_db()
                self.assertEqual(
                    {
                        "member_id": contact.member_id,
                        "email_type": contact.email_type,
                        "verified": contact.verified,
                    },
                    contact_snapshot,
                )
                self.assertEqual(
                    {
                        "email": contact.member.email,
                        "first_name": contact.member.first_name,
                        "last_name": contact.member.last_name,
                        "is_active": contact.member.is_active,
                        "access_level": contact.member.access_level,
                        "password": contact.member.password,
                    },
                    member_snapshot,
                )
                self.assertEqual(
                    {
                        "members": Member.objects.count(),
                        "contacts": ContactEmail.objects.count(),
                        "participants": Participant.objects.filter(event=self.event).count(),
                        "user_events": UserEvent.objects.filter(event=self.event).count(),
                        "invitations": EventInvitation.objects.filter(event=self.event).count(),
                    },
                    model_counts,
                )

    def test_existing_invitation_is_repaired_for_the_reused_member_and_organizer(self):
        target = create_member("target@example.com", "Target", "Member")
        invitation = EventInvitation.objects.create(
            event=self.event,
            email="target@example.com",
            member=self.outsider,
            invited_by=None,
        )

        result = create_or_reuse_managed_participant(
            event=self.event,
            organizer=self.organizer,
            name="Event display name",
            email="target@example.com",
        )

        invitation.refresh_from_db()
        self.assertEqual(result["invitation"].pk, invitation.pk)
        self.assertEqual(invitation.member_id, target.pk)
        self.assertEqual(invitation.invited_by_id, self.organizer.pk)

    def test_temporary_session_string_and_idempotent_revoke_reflect_state(self):
        result = create_or_reuse_managed_participant(
            event=self.event,
            organizer=self.organizer,
            name="Session Person",
            email="session@example.com",
        )
        participant = result["participant"]
        session = TemporaryEventSession.objects.create(
            member=participant.member,
            participant=participant,
            invitation=result["invitation"],
            secret_hash="a" * 64,
            expires_at=timezone.now() + timedelta(days=1),
        )

        self.assertIn(f"{self.event.code} [active]", str(session))
        self.assertTrue(session.revoke())
        self.assertFalse(session.revoke())
        self.assertIn(f"{self.event.code} [revoked/expired]", str(session))

    def test_private_participant_payload_falls_back_to_contact_and_email_invitation(self):
        Member = get_user_model()
        member = Member.objects.create_user(
            email="",
            first_name="Contact",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=member,
            email_address="contact-only@example.com",
            email_type="primary",
            verified=True,
        )
        participant = Participant.objects.create(
            event=self.event,
            member=member,
            participant_name="Contact participant",
            availability_inperson=default_availability(self.event),
            availability_virtual=default_availability(self.event),
        )
        EventInvitation.objects.create(
            event=self.event,
            email="contact-only@example.com",
            member=None,
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )

        payload = api_participant(participant, organizer_private=True)

        self.assertEqual(payload["email"], "contact-only@example.com")
        self.assertEqual(payload["invitationStatus"], "invited")
        self.assertEqual(payload["accountAccess"], "full")
        self.assertFalse(payload["canOrganizerEditAvailability"])

    def test_private_participant_payload_handles_a_direct_invitation_and_no_email(self):
        directly_invited = create_member("direct@example.com", "Direct", "Invite")
        direct_participant = Participant.objects.create(
            event=self.event,
            member=directly_invited,
            participant_name="Direct participant",
            availability_inperson=default_availability(self.event),
            availability_virtual=default_availability(self.event),
        )
        EventInvitation.objects.create(
            event=self.event,
            email="direct@example.com",
            member=directly_invited,
            invited_by=self.organizer,
        )
        direct_payload = api_participant(direct_participant, organizer_private=True)
        self.assertEqual(direct_payload["invitationStatus"], "not_sent")

        Member = get_user_model()
        no_email_member = Member.objects.create_user(first_name="No email", is_active=True)
        no_email_participant = Participant.objects.create(
            event=self.event,
            member=no_email_member,
            participant_name="No email participant",
            availability_inperson=default_availability(self.event),
            availability_virtual=default_availability(self.event),
        )
        no_email_payload = api_participant(no_email_participant, organizer_private=True)
        self.assertEqual(no_email_payload["email"], "")
        self.assertEqual(no_email_payload["invitationStatus"], "not_sent")

    def test_private_participant_payload_uses_event_alias_instead_of_primary_email(self):
        member = create_member("personal@example.com", "Alias", "Member")
        ContactEmail.objects.create(
            member=member,
            email_address="work-alias@example.com",
            email_type="secondary",
            verified=True,
        )
        member_count = get_user_model().objects.count()
        result = create_or_reuse_managed_participant(
            event=self.event,
            organizer=self.organizer,
            name="Event alias",
            email="work-alias@example.com",
        )

        payload = api_participant(result["participant"], organizer_private=True)

        self.assertEqual(result["participant"].member_id, member.pk)
        self.assertFalse(result["memberCreated"])
        self.assertEqual(get_user_model().objects.count(), member_count)
        self.assertTrue(
            UserEvent.objects.filter(
                event=self.event,
                member=member,
                role="participant",
            ).exists()
        )
        self.assertEqual(result["invitation"].member_id, member.pk)
        self.assertEqual(payload["email"], "work-alias@example.com")
        self.assertNotEqual(payload["email"], "personal@example.com")
        self.assertEqual(payload["accountAccess"], "full")
        self.assertFalse(payload["canOrganizerEditAvailability"])

    def test_organizer_participant_listing_ignores_duplicate_member_invitations(self):
        first = create_member("first@example.com", "First", "Member")
        second = create_member("second@example.com", "Second", "Member")
        for member in (first, second):
            Participant.objects.create(
                event=self.event,
                member=member,
                participant_name=member.display_name(),
                availability_inperson=default_availability(self.event),
                availability_virtual=default_availability(self.event),
            )

        EventInvitation.objects.create(
            event=self.event,
            email="second@example.com",
            member=second,
            invited_by=self.organizer,
        )
        EventInvitation.objects.create(
            event=self.event,
            email="first-alias@example.com",
            member=first,
            invited_by=self.organizer,
        )
        EventInvitation.objects.create(
            event=self.event,
            email="first@example.com",
            member=first,
            invited_by=self.organizer,
        )

        client = APIClient()
        client.force_authenticate(self.organizer)
        response = client.get(f"/events/participants?code={self.event.code}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data["participants"]), 2)
