from datetime import timedelta
from unittest.mock import patch

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework import serializers
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.authentication import SessionJWTAuthentication
from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.authn.services import (
    _complete_temporary_account_upgrade,
    complete_registration,
    issue_auth_session,
    issue_email_challenge,
    login_with_password,
    start_registration,
    verify_email_challenge,
)
from apps.authn.tests.helpers import create_member
from apps.authn.tests.test_auth_edges import latest_code
from apps.scheduling.models import (
    Event,
    EventInvitation,
    Participant,
    TemporaryEventSession,
    UserEvent,
)


class TemporaryIdentityTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("organizer@example.com", "Event", "Owner")
        self.Member = get_user_model()

    def create_temporary_member(self, email="temporary@example.com"):
        member = self.Member.objects.create_user(
            password=None,
            email=email,
            first_name="Temporary",
            last_name="Person",
            is_active=True,
            access_level=self.Member.AccessLevel.TEMPORARY,
        )
        ContactEmail.objects.create(
            member=member,
            email_address=email,
            email_type="primary",
            verified=False,
        )
        return member

    def test_temp_event_challenges_are_isolated_by_scope(self):
        member = self.create_temporary_member()
        first = issue_email_challenge(
            member=member,
            purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS,
            target_email="temporary@example.com",
            scope_key="event-a:invitation-a",
        )
        second = issue_email_challenge(
            member=member,
            purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS,
            target_email="temporary@example.com",
            scope_key="event-b:invitation-b",
        )
        replacement = issue_email_challenge(
            member=member,
            purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS,
            target_email="temporary@example.com",
            scope_key="event-a:invitation-a",
        )

        first.challenge.refresh_from_db()
        second.challenge.refresh_from_db()
        self.assertEqual(first.challenge.status, EmailAuthChallenge.Status.EXPIRED)
        self.assertEqual(second.challenge.status, EmailAuthChallenge.Status.PENDING)
        self.assertEqual(replacement.challenge.scope_key, "event-a:invitation-a")
        self.assertEqual(
            EmailAuthChallenge.objects.filter(status=EmailAuthChallenge.Status.PENDING).count(),
            2,
        )

        with self.assertRaises(serializers.ValidationError):
            verify_email_challenge(
                email="temporary@example.com",
                code=replacement.code,
                purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS,
                scope_key="event-c:invitation-c",
            )
        verified = verify_email_challenge(
            email="temporary@example.com",
            code=replacement.code,
            purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS,
            scope_key="event-a:invitation-a",
        )
        self.assertEqual(verified.pk, replacement.challenge.pk)

    def test_temporary_member_cannot_use_normal_authentication(self):
        member = self.create_temporary_member()
        member.set_password("password123")
        member.save(update_fields=["password"])

        with self.assertRaises(serializers.ValidationError):
            issue_auth_session(member)
        with self.assertRaises(serializers.ValidationError):
            login_with_password("temporary@example.com", "password123")

        response = self.client.post(
            "/authn/login/request-code/",
            {"email": "temporary@example.com"},
            format="json",
        )
        self.assertEqual(response.status_code, 202)
        self.assertFalse(
            EmailAuthChallenge.objects.filter(
                member=member,
                purpose=EmailAuthChallenge.Purpose.LOGIN,
            ).exists()
        )

    def test_public_registration_cannot_mutate_or_replace_a_temporary_identity(self):
        member = self.create_temporary_member()
        member.set_password("original-password-123")
        member.save(update_fields=["password"])
        original_password = member.password
        existing = issue_email_challenge(
            member=member,
            purpose=EmailAuthChallenge.Purpose.REGISTER,
            target_email="temporary@example.com",
        ).challenge
        original_challenge = {
            "code_hash": existing.code_hash,
            "status": existing.status,
            "attempts": existing.attempts,
            "expires_at": existing.expires_at,
        }

        response = self.client.post(
            "/authn/register/",
            {
                "email": "temporary@example.com",
                "password": "attacker-password-123",
                "password_confirm": "attacker-password-123",
                "first_name": "Attacker",
                "last_name": "Controlled",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertNotIn("temporary", response.content.decode().lower())
        member.refresh_from_db()
        existing.refresh_from_db()
        self.assertEqual(member.first_name, "Temporary")
        self.assertEqual(member.last_name, "Person")
        self.assertEqual(member.password, original_password)
        self.assertEqual(
            EmailAuthChallenge.objects.filter(
                member=member,
                purpose=EmailAuthChallenge.Purpose.REGISTER,
            ).count(),
            1,
        )
        self.assertEqual(
            {
                "code_hash": existing.code_hash,
                "status": existing.status,
                "attempts": existing.attempts,
                "expires_at": existing.expires_at,
            },
            original_challenge,
        )

    def test_temporary_upgrade_authorization_must_match_the_contact_member(self):
        member = self.create_temporary_member()
        original_password = member.password

        with self.assertRaisesMessage(serializers.ValidationError, "Unable to register"):
            start_registration(
                {
                    "email": "temporary@example.com",
                    "password": "attacker-password-123",
                    "password_confirm": "attacker-password-123",
                    "first_name": "Attacker",
                    "last_name": "Controlled",
                },
                _temporary_upgrade_member_id=self.organizer.pk,
            )

        with self.assertRaisesMessage(serializers.ValidationError, "Unable to register"):
            start_registration(
                {
                    "email": "temporary@example.com",
                    "password": "attacker-password-123",
                    "password_confirm": "attacker-password-123",
                    "first_name": "Attacker",
                    "last_name": "Controlled",
                },
                _temporary_upgrade_member_id="not-a-member-uuid",
            )

        member.refresh_from_db()
        self.assertEqual(member.first_name, "Temporary")
        self.assertEqual(member.last_name, "Person")
        self.assertEqual(member.password, original_password)
        self.assertFalse(
            EmailAuthChallenge.objects.filter(
                member=member,
                purpose=EmailAuthChallenge.Purpose.REGISTER,
            ).exists()
        )

    def test_temporary_member_is_rejected_even_with_a_valid_jwt(self):
        member = self.create_temporary_member()
        access = RefreshToken.for_user(member).access_token
        authentication = SessionJWTAuthentication()
        validated = authentication.get_validated_token(str(access))

        with self.assertRaisesMessage(AuthenticationFailed, "Full account access is required"):
            authentication.get_user(validated)

    def test_upgrade_cleanup_is_safe_without_a_name_or_temp_session_model(self):
        member = self.create_temporary_member()
        member.first_name = ""
        member.last_name = ""
        member.save(update_fields=["first_name", "last_name"])
        real_get_model = django_apps.get_model

        def get_model(app_label, model_name):
            if model_name == "TemporaryEventSession":
                raise LookupError(model_name)
            return real_get_model(app_label, model_name)

        with (
            patch("apps.authn.services.apps.get_model", side_effect=get_model),
            patch("apps.authn.services.logger.info") as log_info,
        ):
            _complete_temporary_account_upgrade(member)

        self.assertFalse(UserEvent.objects.filter(member=member).exists())
        log_info.assert_called_once_with(
            "temporary_account_upgraded",
            extra={"member_id": str(member.pk), "participation_count": 0},
        )

    def test_registration_upgrades_same_member_and_preserves_scheduling_identity(self):
        member = self.create_temporary_member()
        event = Event.objects.create(
            code="TMPUPGRADE",
            name="Upgrade event",
            organizer=self.organizer,
        )
        participant = Participant.objects.create(
            event=event,
            member=member,
            participant_name="Organizer-entered name",
        )
        original_participant_version = participant.version
        invitation = EventInvitation.objects.create(
            event=event,
            email="temporary@example.com",
            member=member,
            invited_by=self.organizer,
        )
        temp_session = TemporaryEventSession.objects.create(
            member=member,
            participant=participant,
            invitation=invitation,
            secret_hash="a" * 64,
            expires_at=timezone.now() + timedelta(days=7),
        )

        original_id = member.pk
        pending = start_registration(
            {
                "email": "temporary@example.com",
                "password": "password123",
                "password_confirm": "password123",
                "first_name": "Formal",
                "last_name": "Name",
            },
            _temporary_upgrade_member_id=member.pk,
        )
        self.assertEqual(pending.pk, original_id)
        self.assertEqual(pending.access_level, self.Member.AccessLevel.TEMPORARY)
        self.assertTrue(pending.is_active)
        self.assertFalse(ContactEmail.objects.get(member=pending).verified)
        temp_session.refresh_from_db()
        self.assertIsNone(temp_session.revoked_at)

        completed = complete_registration("temporary@example.com", latest_code())
        self.assertEqual(completed.pk, original_id)
        self.assertEqual(completed.access_level, self.Member.AccessLevel.FULL)
        self.assertTrue(ContactEmail.objects.get(member=completed).verified)
        participant.refresh_from_db()
        self.assertEqual(participant.member_id, original_id)
        self.assertEqual(participant.participant_name, "Formal Name")
        self.assertEqual(participant.version, original_participant_version + 1)
        self.assertTrue(
            UserEvent.objects.filter(
                member=completed,
                event=event,
                role="participant",
            ).exists()
        )
        temp_session.refresh_from_db()
        self.assertIsNotNone(temp_session.revoked_at)
        self.assertEqual(
            login_with_password("temporary@example.com", "password123").pk,
            original_id,
        )


class TemporaryIdentityRollbackCompatibilityTests(TransactionTestCase):
    """The pre-feature ORM must keep writing after the additive migration lands."""

    def test_pre_temporary_identity_models_use_persistent_database_defaults(self):
        executor = MigrationExecutor(connection)
        old_apps = executor.loader.project_state([("authn", "0002_secure_auth_sessions")]).apps
        OldMember = old_apps.get_model("authn", "Member")
        OldEmailAuthChallenge = old_apps.get_model("authn", "EmailAuthChallenge")

        old_member = OldMember.objects.create(
            email="rollback-compatible@example.com",
            first_name="Rollback",
            last_name="Compatible",
            password="!",
            is_active=True,
        )
        old_challenge = OldEmailAuthChallenge.objects.create(
            member_id=old_member.pk,
            purpose="login",
            channel="email",
            target_email="rollback-compatible@example.com",
            code_hash="legacy-code-hash",
            expires_at=timezone.now() + timedelta(minutes=10),
        )

        member = get_user_model().objects.get(pk=old_member.pk)
        challenge = EmailAuthChallenge.objects.get(pk=old_challenge.pk)
        self.assertEqual(member.access_level, member.AccessLevel.FULL)
        self.assertEqual(challenge.scope_key, "")
