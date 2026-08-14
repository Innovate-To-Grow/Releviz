from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.authn.services import claim_unclaimed_contact_email
from apps.scheduling.models import (
    Event,
    EventInvitation,
    Participant,
    TemporaryEventSession,
    UserEvent,
)

Member = get_user_model()


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class EmailCodeAuthLoginTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.password = "StrongPass123!"
        self.member = Member.objects.create_user(
            password=self.password,
            is_active=True,
        )
        self.primary_email = ContactEmail.objects.create(
            member=self.member,
            email_address="member@example.com",
            email_type="primary",
            verified=True,
        )
        self.alias = ContactEmail.objects.create(
            member=self.member,
            email_address="alias@example.com",
            email_type="secondary",
            verified=True,
        )

    def test_password_login_accepts_verified_contact_email(self, _mock_code, _mock_send):
        response = self.client.post(
            "/authn/login/",
            {"email": self.alias.email_address, "password": self.password},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["user"]["email"], self.primary_email.email_address)
        self.assertNotIn("username", response.data["user"])
        self.assertIn("access", response.data)
        self.assertEqual(response.data["next_step"], "complete_profile")
        self.assertTrue(response.data["requires_profile_completion"])

    def test_password_login_rejects_unverified_contact_email(self, _mock_code, _mock_send):
        unverified = ContactEmail.objects.create(
            member=self.member,
            email_address="pending@example.com",
            email_type="other",
            verified=False,
        )

        response = self.client.post(
            "/authn/login/",
            {"email": unverified.email_address, "password": self.password},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["non_field_errors"][0], "Invalid credentials.")

    def test_login_code_flow_accepts_verified_contact_email(self, _mock_code, mock_send):
        request_response = self.client.post(
            "/authn/login/request-code/",
            {"email": self.alias.email_address},
            format="json",
        )

        self.assertEqual(request_response.status_code, 202)
        self.assertEqual(EmailAuthChallenge.objects.count(), 1)
        mock_send.assert_called_once()
        self.assertEqual(mock_send.call_args.kwargs["link_flow"], "login")
        self.assertEqual(mock_send.call_args.kwargs["link_source"], "login")

        verify_response = self.client.post(
            "/authn/login/verify-code/",
            {"email": self.alias.email_address, "code": "654321"},
            format="json",
        )

        self.assertEqual(verify_response.status_code, 200)
        self.assertEqual(verify_response.data["user"]["email"], self.primary_email.email_address)
        self.assertEqual(
            EmailAuthChallenge.objects.first().status, EmailAuthChallenge.Status.CONSUMED
        )
        self.assertEqual(verify_response.data["next_step"], "complete_profile")
        self.assertTrue(verify_response.data["requires_profile_completion"])

    def test_password_login_routes_incomplete_profile_to_complete_profile(
        self, _mock_code, _mock_send
    ):
        self.member.first_name = ""
        self.member.last_name = ""
        self.member.save(update_fields=["first_name", "last_name", "updated_at"])

        response = self.client.post(
            "/authn/login/",
            {"email": self.alias.email_address, "password": self.password},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["next_step"], "complete_profile")
        self.assertTrue(response.data["requires_profile_completion"])

    def test_login_code_flow_routes_incomplete_profile_to_complete_profile(
        self, _mock_code, _mock_send
    ):
        self.member.first_name = ""
        self.member.last_name = ""
        self.member.save(update_fields=["first_name", "last_name", "updated_at"])

        self.client.post(
            "/authn/login/request-code/",
            {"email": self.alias.email_address},
            format="json",
        )

        verify_response = self.client.post(
            "/authn/login/verify-code/",
            {"email": self.alias.email_address, "code": "654321"},
            format="json",
        )

        self.assertEqual(verify_response.status_code, 200)
        self.assertEqual(verify_response.data["next_step"], "complete_profile")
        self.assertTrue(verify_response.data["requires_profile_completion"])

    def test_unified_email_auth_uses_login_flow_for_active_primary_email(
        self, _mock_code, mock_send
    ):
        request_response = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": self.primary_email.email_address},
            format="json",
        )

        self.assertEqual(request_response.status_code, 202)
        self.assertNotIn("flow", request_response.data)
        self.assertNotIn("next_step", request_response.data)
        self.assertEqual(mock_send.call_args.kwargs["link_flow"], "auth")
        self.assertEqual(mock_send.call_args.kwargs["link_source"], "login")

        verify_response = self.client.post(
            "/authn/email-auth/verify-code/",
            {"email": self.primary_email.email_address, "code": "654321"},
            format="json",
        )

        self.assertEqual(verify_response.status_code, 200)
        self.assertEqual(verify_response.data["next_step"], "complete_profile")
        self.assertTrue(verify_response.data["requires_profile_completion"])
        self.assertIn("access", verify_response.data)
        self.assertNotIn("refresh", verify_response.data)
        refresh_cookie = verify_response.cookies[settings.AUTH_REFRESH_COOKIE_NAME]
        self.assertTrue(refresh_cookie["httponly"])

    def test_unified_email_auth_forwards_safe_next_path(self, _mock_code, mock_send):
        response = self.client.post(
            "/authn/email-auth/request-code/",
            {
                "email": self.primary_email.email_address,
                "next": "/settings?complete_profile=1",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(mock_send.call_args.kwargs["link_next"], "/settings?complete_profile=1")

    def test_unified_email_auth_rejects_external_next_url(self, _mock_code, _mock_send):
        response = self.client.post(
            "/authn/email-auth/request-code/",
            {
                "email": self.primary_email.email_address,
                "next": "https://attacker.example/steal",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)

    def test_unified_email_auth_uses_requested_source_for_email_link(self, _mock_code, mock_send):
        response = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": self.primary_email.email_address, "source": "subscribe"},
            format="json",
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(mock_send.call_args.kwargs["link_flow"], "auth")
        self.assertEqual(mock_send.call_args.kwargs["link_source"], "subscribe")

    def test_unified_email_auth_forwards_event_slug_to_email_link(self, _mock_code, mock_send):
        response = self.client.post(
            "/authn/email-auth/request-code/",
            {
                "email": self.primary_email.email_address,
                "source": "event_registration",
                "event": "demo-day",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(mock_send.call_args.kwargs["link_event"], "demo-day")

    def test_unified_email_auth_defaults_event_to_empty(self, _mock_code, mock_send):
        response = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": self.primary_email.email_address, "source": "event_registration"},
            format="json",
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(mock_send.call_args.kwargs["link_event"], "")

    def test_unified_email_auth_rejects_invalid_event_slug(self, _mock_code, _mock_send):
        response = self.client.post(
            "/authn/email-auth/request-code/",
            {
                "email": self.primary_email.email_address,
                "source": "event_registration",
                "event": "bad slug!",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)

    def test_unified_email_auth_forwards_event_slug_on_register_branch(self, _mock_code, mock_send):
        response = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": "brand-new@example.com", "source": "event_registration", "event": "demo-day"},
            format="json",
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(mock_send.call_args.kwargs["link_event"], "demo-day")

    def test_unified_email_auth_uses_login_flow_for_verified_contact_email(
        self, _mock_code, _mock_send
    ):
        request_response = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": self.alias.email_address},
            format="json",
        )

        self.assertEqual(request_response.status_code, 202)
        self.assertNotIn("flow", request_response.data)

        verify_response = self.client.post(
            "/authn/email-auth/verify-code/",
            {"email": self.alias.email_address, "code": "654321"},
            format="json",
        )

        self.assertEqual(verify_response.status_code, 200)
        self.assertEqual(verify_response.data["user"]["email"], self.primary_email.email_address)
        self.assertEqual(verify_response.data["next_step"], "complete_profile")
        self.assertTrue(verify_response.data["requires_profile_completion"])

    def test_unified_email_auth_creates_pending_member_without_password(
        self, _mock_code, _mock_send
    ):
        request_response = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": "new-flow@example.com"},
            format="json",
        )

        self.assertEqual(request_response.status_code, 202)
        self.assertNotIn("flow", request_response.data)
        primary_contact = ContactEmail.objects.get(email_address="new-flow@example.com")
        pending = primary_contact.member
        self.assertFalse(pending.is_active)
        self.assertFalse(pending.has_usable_password())
        self.assertEqual(pending.first_name, "")
        self.assertTrue(primary_contact.subscribe)

        verify_response = self.client.post(
            "/authn/email-auth/verify-code/",
            {"email": "new-flow@example.com", "code": "654321"},
            format="json",
        )

        pending.refresh_from_db()
        primary_contact.refresh_from_db()
        self.assertEqual(verify_response.status_code, 200)
        self.assertTrue(pending.is_active)
        self.assertTrue(primary_contact.subscribe)
        self.assertEqual(verify_response.data["next_step"], "complete_profile")
        self.assertTrue(verify_response.data["requires_profile_completion"])
        self.assertIn("access", verify_response.data)

    def test_unified_email_auth_claims_unowned_subscriber_contact(self, _mock_code, _mock_send):
        ContactEmail.objects.create(
            email_address="subscriber@example.com",
            email_type="other",
            subscribe=True,
        )

        request_response = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": "subscriber@example.com", "source": "event_registration"},
            format="json",
        )

        self.assertEqual(request_response.status_code, 202)
        self.assertEqual(
            ContactEmail.objects.filter(email_address="subscriber@example.com").count(), 1
        )
        contact = ContactEmail.objects.get(email_address="subscriber@example.com")
        pending = contact.member
        self.assertIsNotNone(pending)
        self.assertEqual(contact.email_type, "primary")
        self.assertFalse(contact.verified)
        self.assertTrue(contact.subscribe)
        self.assertFalse(pending.is_active)

        verify_response = self.client.post(
            "/authn/email-auth/verify-code/",
            {"email": "subscriber@example.com", "code": "654321"},
            format="json",
        )

        pending.refresh_from_db()
        contact.refresh_from_db()
        self.assertEqual(verify_response.status_code, 200)
        self.assertTrue(pending.is_active)
        self.assertTrue(contact.verified)
        self.assertTrue(contact.subscribe)

    def test_claim_unowned_subscriber_contact_does_not_overwrite_existing_claim(
        self, _mock_code, _mock_send
    ):
        first_member = Member.objects.create_user(password="FirstPass123!", is_active=False)
        second_member = Member.objects.create_user(password="SecondPass123!", is_active=False)
        contact = ContactEmail.objects.create(
            email_address="claim-race@example.com",
            email_type="other",
            subscribe=True,
        )

        first_claim = claim_unclaimed_contact_email(contact.email_address, member=first_member)
        second_claim = claim_unclaimed_contact_email(contact.email_address, member=second_member)

        contact.refresh_from_db()
        self.assertIsNotNone(first_claim)
        self.assertIsNone(second_claim)
        self.assertEqual(contact.member_id, first_member.pk)
        self.assertEqual(contact.email_type, "primary")
        self.assertFalse(contact.verified)

    def test_unified_email_auth_reuses_pending_member(self, _mock_code, _mock_send):
        pending = Member.objects.create_user(
            password="OldPass123!",
            is_active=False,
            first_name="Existing",
        )
        ContactEmail.objects.create(
            member=pending,
            email_address="pending-flow@example.com",
            email_type="primary",
            verified=False,
        )

        request_response = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": "pending-flow@example.com"},
            format="json",
        )

        pending.refresh_from_db()
        self.assertEqual(request_response.status_code, 202)
        self.assertNotIn("flow", request_response.data)
        self.assertEqual(
            ContactEmail.objects.filter(email_address="pending-flow@example.com").count(), 1
        )
        self.assertEqual(pending.first_name, "Existing")

        verify_response = self.client.post(
            "/authn/email-auth/verify-code/",
            {"email": "pending-flow@example.com", "code": "654321"},
            format="json",
        )
        self.assertEqual(verify_response.status_code, 200)
        self.assertTrue(
            ContactEmail.objects.get(email_address="pending-flow@example.com").subscribe
        )

    def test_unified_email_auth_does_not_reactivate_disabled_verified_member(
        self, _mock_code, _mock_send
    ):
        disabled = Member.objects.create_user(
            password="OldPass123!",
            is_active=False,
            first_name="Disabled",
        )
        ContactEmail.objects.create(
            member=disabled,
            email_address="disabled@example.com",
            email_type="primary",
            verified=True,
        )

        request_response = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": "disabled@example.com"},
            format="json",
        )
        verify_response = self.client.post(
            "/authn/email-auth/verify-code/",
            {"email": "disabled@example.com", "code": "654321"},
            format="json",
        )

        disabled.refresh_from_db()
        self.assertEqual(request_response.status_code, 202)
        self.assertEqual(verify_response.status_code, 400)
        self.assertFalse(disabled.is_active)
        self.assertFalse(
            EmailAuthChallenge.objects.filter(member=disabled, purpose="register").exists()
        )

    def test_unified_email_auth_rejects_conflicting_contact_email(self, _mock_code, _mock_send):
        ContactEmail.objects.create(
            member=self.member,
            email_address="blocked@example.com",
            email_type="other",
            verified=False,
        )

        response = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": "blocked@example.com"},
            format="json",
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.data["message"], "Check your email for a verification code.")
        self.assertEqual(EmailAuthChallenge.objects.count(), 0)


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class EventInvitationUnifiedAuthTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.organizer = Member.objects.create_user(
            password="StrongPass123!",
            first_name="Event",
            last_name="Owner",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.organizer,
            email_address="event-owner@example.com",
            email_type="primary",
            verified=True,
        )
        self.event = Event.objects.create(
            code="PROFILE1",
            name="Profile completion event",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            access_mode="invite_only",
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )

    def create_temporary_invitee(self, email="invited-profile@example.com"):
        member = Member.objects.create_user(
            password=None,
            email=email,
            first_name="Invited Name",
            last_name="",
            is_active=True,
            access_level=Member.AccessLevel.TEMPORARY,
        )
        member.set_unusable_password()
        member.save(update_fields=["password", "updated_at"])
        contact = ContactEmail.objects.create(
            member=member,
            email_address=email,
            email_type="primary",
            verified=False,
        )
        participant = Participant.objects.create(
            event=self.event,
            member=member,
            participant_name="Invited Name",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        invitation = EventInvitation.objects.create(
            event=self.event,
            member=member,
            email=email,
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        user_event = UserEvent.objects.create(
            event=self.event,
            member=member,
            role="participant",
        )
        session = TemporaryEventSession.objects.create(
            member=member,
            participant=participant,
            invitation=invitation,
            secret_hash=f"session-{member.pk}",
            expires_at=timezone.now() + timedelta(hours=1),
        )
        return member, contact, participant, invitation, user_event, session

    def request_event_auth(self, *, email, event_code=None):
        return self.client.post(
            "/authn/email-auth/request-code/",
            {
                "email": email,
                "source": "event_registration",
                "event": event_code or self.event.code,
                "next": f"/event?code={event_code or self.event.code}",
            },
            format="json",
        )

    def test_invited_temporary_member_upgrades_in_place_without_losing_event_records(
        self, _mock_code, mock_send
    ):
        member, contact, participant, invitation, user_event, session = (
            self.create_temporary_invitee()
        )
        original_ids = {
            "member": member.pk,
            "participant": participant.pk,
            "invitation": invitation.pk,
            "user_event": user_event.pk,
        }

        requested = self.request_event_auth(email=contact.email_address)

        self.assertEqual(requested.status_code, 202)
        mock_send.assert_called_once()
        challenge = EmailAuthChallenge.objects.get(
            member=member,
            purpose=EmailAuthChallenge.Purpose.REGISTER,
        )
        self.assertEqual(challenge.target_email, contact.email_address)
        self.assertEqual(mock_send.call_args.kwargs["link_source"], "event_registration")
        self.assertEqual(mock_send.call_args.kwargs["link_event"], self.event.code)

        verified = self.client.post(
            "/authn/email-auth/verify-code/",
            {"email": contact.email_address, "code": "654321"},
            format="json",
        )

        self.assertEqual(verified.status_code, 200, verified.data)
        self.assertTrue(verified.data["requires_profile_completion"])
        self.assertEqual(verified.data["next_step"], "complete_profile")
        member.refresh_from_db()
        contact.refresh_from_db()
        participant.refresh_from_db()
        invitation.refresh_from_db()
        user_event.refresh_from_db()
        session.refresh_from_db()
        self.assertEqual(member.pk, original_ids["member"])
        self.assertEqual(member.access_level, Member.AccessLevel.FULL)
        self.assertTrue(member.is_active)
        self.assertTrue(contact.verified)
        self.assertEqual(participant.pk, original_ids["participant"])
        self.assertEqual(participant.member_id, member.pk)
        self.assertEqual(invitation.pk, original_ids["invitation"])
        self.assertEqual(invitation.member_id, member.pk)
        self.assertEqual(user_event.pk, original_ids["user_event"])
        self.assertEqual(user_event.member_id, member.pk)
        self.assertIsNotNone(session.revoked_at)

    def test_wrong_event_does_not_issue_registration_for_temporary_member(
        self, _mock_code, mock_send
    ):
        member, contact, *_records = self.create_temporary_invitee()
        Event.objects.create(
            code="PROFILE2",
            name="Other event",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            access_mode="invite_only",
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )

        response = self.request_event_auth(
            email=contact.email_address,
            event_code="PROFILE2",
        )

        self.assertEqual(response.status_code, 202)
        mock_send.assert_not_called()
        self.assertFalse(
            EmailAuthChallenge.objects.filter(
                member=member,
                purpose=EmailAuthChallenge.Purpose.REGISTER,
            ).exists()
        )
        member.refresh_from_db()
        self.assertEqual(member.access_level, Member.AccessLevel.TEMPORARY)

    def test_full_or_disabled_account_is_not_claimed_as_event_temporary_registration(
        self, _mock_code, mock_send
    ):
        full = Member.objects.create_user(
            password="StrongPass123!",
            first_name="Full",
            last_name="Account",
            is_active=False,
            access_level=Member.AccessLevel.FULL,
        )
        contact = ContactEmail.objects.create(
            member=full,
            email_address="disabled-full@example.com",
            email_type="primary",
            verified=True,
        )
        participant = Participant.objects.create(
            event=self.event,
            member=full,
            participant_name="Full Account",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        EventInvitation.objects.create(
            event=self.event,
            member=full,
            email=contact.email_address,
            invited_by=self.organizer,
        )

        response = self.request_event_auth(email=contact.email_address)

        self.assertEqual(response.status_code, 202)
        mock_send.assert_not_called()
        self.assertFalse(EmailAuthChallenge.objects.filter(member=full).exists())
        full.refresh_from_db()
        participant.refresh_from_db()
        self.assertFalse(full.is_active)
        self.assertEqual(full.access_level, Member.AccessLevel.FULL)
        self.assertEqual(participant.member_id, full.pk)
