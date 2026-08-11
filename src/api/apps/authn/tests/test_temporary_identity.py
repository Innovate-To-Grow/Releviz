from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.models.query import QuerySet
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework import serializers
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.authentication import SessionJWTAuthentication
from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.authn.services import (
    TEMP_MAILBOX_REGISTRATION_SCOPE,
    TEMP_SESSION_REGISTRATION_SCOPE,
    _complete_temporary_account_upgrade,
    _recover_rollback_temporary_password_account,
    complete_registration,
    issue_auth_session,
    issue_email_challenge,
    login_with_password,
    start_registration,
    verify_email_challenge,
)
from apps.authn.tests.helpers import create_member
from apps.authn.tests.test_auth_edges import latest_code
from apps.messaging.models import EmailDeliveryJob, EmailMessageLog
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

    def test_public_registration_stages_temporary_identity_changes_until_mailbox_proof(self):
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

        self.assertEqual(response.status_code, 202)
        self.assertTrue(response.data["requiresRegistrationDetailsOnVerify"])
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
            2,
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
        mailbox_challenge = EmailAuthChallenge.objects.get(
            member=member,
            purpose=EmailAuthChallenge.Purpose.REGISTER,
            scope_key=TEMP_MAILBOX_REGISTRATION_SCOPE,
        )
        self.assertEqual(mailbox_challenge.status, EmailAuthChallenge.Status.PENDING)

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
            extra={
                "member_id": str(member.pk),
                "participation_count": 0,
                "expired_challenge_count": 0,
                "canceled_auth_job_count": 0,
                "canceled_event_job_count": 0,
                "revoked_session_count": 0,
            },
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

        challenge = EmailAuthChallenge.objects.get(
            member=member,
            purpose=EmailAuthChallenge.Purpose.REGISTER,
            status=EmailAuthChallenge.Status.PENDING,
        )
        self.assertEqual(challenge.scope_key, TEMP_SESSION_REGISTRATION_SCOPE)
        completed = complete_registration(
            "temporary@example.com",
            latest_code(),
            temporary_upgrade=True,
        )
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

    def test_mailbox_claim_recovers_inactive_unverified_rollback_identity(self):
        member = self.create_temporary_member("rollback-mailbox@example.com")
        member.is_active = False
        member.first_name = "Legacy"
        member.last_name = "Temporary"
        member.save(update_fields=["is_active", "first_name", "last_name"])
        original_id = member.pk
        original_password = member.password
        registration = {
            "email": "rollback-mailbox@example.com",
            "password": "recovered-password-123",
            "password_confirm": "recovered-password-123",
            "first_name": "Recovered",
            "last_name": "Owner",
            "organization": "Mailbox Org",
            "title": "Coordinator",
        }

        started = self.client.post("/authn/register/", registration, format="json")
        self.assertEqual(started.status_code, 202, started.data)
        code = latest_code()
        member.refresh_from_db()
        self.assertEqual(member.pk, original_id)
        self.assertFalse(member.is_active)
        self.assertEqual(member.first_name, "Legacy")
        self.assertEqual(member.password, original_password)

        invalid_details = self.client.post(
            "/authn/register/verify-code/",
            {
                "email": registration["email"],
                "code": code,
                "temporaryUpgrade": False,
            },
            format="json",
        )
        self.assertEqual(invalid_details.status_code, 400)
        challenge = EmailAuthChallenge.objects.get(
            member=member,
            purpose=EmailAuthChallenge.Purpose.REGISTER,
            scope_key=TEMP_MAILBOX_REGISTRATION_SCOPE,
        )
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.PENDING)

        invalid_flag = self.client.post(
            "/authn/register/verify-code/",
            {
                **registration,
                "code": code,
                "temporaryUpgrade": "false",
            },
            format="json",
        )
        self.assertEqual(invalid_flag.status_code, 400)
        self.assertIn("temporaryUpgrade", invalid_flag.data)

        completed = self.client.post(
            "/authn/register/verify-code/",
            {
                **registration,
                "code": code,
                "temporaryUpgrade": False,
            },
            format="json",
        )
        self.assertEqual(completed.status_code, 200, completed.data)
        member.refresh_from_db()
        self.assertEqual(member.pk, original_id)
        self.assertEqual(member.access_level, self.Member.AccessLevel.FULL)
        self.assertTrue(member.is_active)
        self.assertTrue(member.check_password("recovered-password-123"))
        self.assertEqual(member.get_full_name(), "Recovered Owner")
        self.assertTrue(ContactEmail.objects.get(member=member).verified)

    def test_registration_scope_flag_and_mailbox_details_cannot_be_crossed(self):
        member = self.create_temporary_member("scope-crossing@example.com")
        registration = {
            "email": "scope-crossing@example.com",
            "password": "scope-password-123",
            "password_confirm": "scope-password-123",
            "first_name": "Scope",
            "last_name": "Owner",
        }
        start_registration(registration)
        code = latest_code()

        with self.assertRaises(serializers.ValidationError):
            complete_registration(
                registration["email"],
                code,
                registration_data={**registration, "email": "other@example.com"},
            )
        with self.assertRaises(serializers.ValidationError):
            complete_registration(
                registration["email"],
                code,
                registration_data=registration,
                temporary_upgrade=True,
            )
        with self.assertRaises(serializers.ValidationError):
            complete_registration(
                self.organizer.email,
                "123456",
                temporary_upgrade=True,
            )

        member.refresh_from_db()
        self.assertEqual(member.access_level, self.Member.AccessLevel.TEMPORARY)
        self.assertEqual(
            EmailAuthChallenge.objects.get(
                member=member,
                scope_key=TEMP_MAILBOX_REGISTRATION_SCOPE,
            ).status,
            EmailAuthChallenge.Status.PENDING,
        )

    def test_mailbox_completion_rechecks_temporary_state_under_lock(self):
        member = self.create_temporary_member("mailbox-race@example.com")
        registration = {
            "email": "mailbox-race@example.com",
            "password": "race-password-123",
            "password_confirm": "race-password-123",
            "first_name": "Race",
            "last_name": "Owner",
        }

        def upgrade_before_member_lock(**_kwargs):
            self.Member.objects.filter(pk=member.pk).update(
                access_level=self.Member.AccessLevel.FULL
            )
            return SimpleNamespace(member_id=member.pk)

        with (
            patch(
                "apps.authn.services.verify_email_challenge",
                side_effect=upgrade_before_member_lock,
            ),
            self.assertRaises(serializers.ValidationError),
        ):
            complete_registration(
                registration["email"],
                "123456",
                registration_data=registration,
            )

        member.refresh_from_db()
        self.assertEqual(member.access_level, self.Member.AccessLevel.TEMPORARY)

    def test_password_login_recovers_verified_rollback_identity_and_upgrade_invariants(self):
        member = self.create_temporary_member("rollback-login@example.com")
        member.set_password("rollback-password-123")
        member.save(update_fields=["password"])
        ContactEmail.objects.filter(member=member).update(verified=True)
        event = Event.objects.create(
            code="ROLLBACKLOGIN",
            name="Rollback login",
            organizer=self.organizer,
        )
        participant = Participant.objects.create(
            event=event,
            member=member,
            participant_name="Old display name",
        )
        invitation = EventInvitation.objects.create(
            event=event,
            email="rollback-login@example.com",
            member=member,
            invited_by=self.organizer,
        )
        temp_session = TemporaryEventSession.objects.create(
            member=member,
            participant=participant,
            invitation=invitation,
            secret_hash="b" * 64,
            expires_at=timezone.now() + timedelta(days=7),
        )
        issued = issue_email_challenge(
            member=member,
            purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS,
            target_email="rollback-login@example.com",
            scope_key="rollback-event-access",
        )
        invitation_job = EmailDeliveryJob.objects.create(
            idempotency_key="rollback-login-invitation",
            message_type=EmailMessageLog.MessageType.INVITATION,
            recipient="rollback-login@example.com",
            subject="Pending invitation",
            body="Pending invitation",
            message_id="<rollback-login-invitation@releviz.local>",
            event=event,
            invitation=invitation,
            status=EmailDeliveryJob.Status.RETRY,
        )
        original_id = member.pk

        recovered = login_with_password(
            "ROLLBACK-LOGIN@example.com",
            "rollback-password-123",
        )

        self.assertEqual(recovered.pk, original_id)
        recovered.refresh_from_db()
        self.assertEqual(recovered.access_level, self.Member.AccessLevel.FULL)
        self.assertEqual(recovered.email, "rollback-login@example.com")
        self.assertTrue(
            UserEvent.objects.filter(
                member=recovered,
                event=event,
                role="participant",
            ).exists()
        )
        participant.refresh_from_db()
        self.assertEqual(participant.member_id, original_id)
        self.assertEqual(participant.participant_name, "Temporary Person")
        temp_session.refresh_from_db()
        self.assertIsNotNone(temp_session.revoked_at)
        issued.challenge.refresh_from_db()
        issued.delivery_job.refresh_from_db()
        invitation_job.refresh_from_db()
        self.assertEqual(issued.challenge.status, EmailAuthChallenge.Status.EXPIRED)
        self.assertEqual(issued.delivery_job.status, EmailDeliveryJob.Status.CANCELED)
        self.assertEqual(invitation_job.status, EmailDeliveryJob.Status.CANCELED)

    def test_invalid_password_does_not_recover_verified_temporary_identity(self):
        member = self.create_temporary_member("rollback-invalid@example.com")
        member.set_password("rollback-password-123")
        member.save(update_fields=["password"])
        ContactEmail.objects.filter(member=member).update(verified=True)

        with (
            patch("apps.authn.services.authenticate") as backend_authenticate,
            self.assertRaises(serializers.ValidationError),
        ):
            login_with_password("rollback-invalid@example.com", "wrong-password")

        backend_authenticate.assert_not_called()
        member.refresh_from_db()
        self.assertEqual(member.access_level, self.Member.AccessLevel.TEMPORARY)

    def test_rollback_password_recovery_rechecks_member_state_after_lock(self):
        member = self.create_temporary_member("rollback-member-race@example.com")
        member.set_password("rollback-password-123")
        member.save(update_fields=["password"])
        ContactEmail.objects.filter(member=member).update(verified=True)
        original_first = QuerySet.first
        race_applied = False

        def upgrade_after_contact_reference(queryset):
            nonlocal race_applied
            result = original_first(queryset)
            if queryset.model is ContactEmail and isinstance(result, dict) and not race_applied:
                self.Member.objects.filter(pk=member.pk).update(
                    access_level=self.Member.AccessLevel.FULL
                )
                race_applied = True
            return result

        with patch.object(QuerySet, "first", new=upgrade_after_contact_reference):
            recovered, recovery_candidate = _recover_rollback_temporary_password_account(
                "rollback-member-race@example.com",
                "rollback-password-123",
            )

        self.assertTrue(race_applied)
        self.assertIsNone(recovered)
        self.assertFalse(recovery_candidate)
        member.refresh_from_db()
        self.assertEqual(member.access_level, self.Member.AccessLevel.FULL)

    def test_rollback_password_recovery_rechecks_contact_state_after_lock(self):
        member = self.create_temporary_member("rollback-contact-race@example.com")
        member.set_password("rollback-password-123")
        member.save(update_fields=["password"])
        contact = ContactEmail.objects.get(member=member)
        contact.verified = True
        contact.save(update_fields=["verified", "updated_at"])
        original_first = QuerySet.first
        race_applied = False

        def unverify_after_member_lock(queryset):
            nonlocal race_applied
            result = original_first(queryset)
            if queryset.model is self.Member and result == member and not race_applied:
                ContactEmail.objects.filter(pk=contact.pk).update(verified=False)
                race_applied = True
            return result

        with patch.object(QuerySet, "first", new=unverify_after_member_lock):
            recovered, recovery_candidate = _recover_rollback_temporary_password_account(
                "rollback-contact-race@example.com",
                "rollback-password-123",
            )

        self.assertTrue(race_applied)
        self.assertIsNone(recovered)
        self.assertFalse(recovery_candidate)
        member.refresh_from_db()
        contact.refresh_from_db()
        self.assertEqual(member.access_level, self.Member.AccessLevel.TEMPORARY)
        self.assertFalse(contact.verified)


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


class TemporaryIdentityReverseMigrationTests(TransactionTestCase):
    migrate_from = ("authn", "0003_temporary_account_identity")
    migrate_to = ("authn", "0002_secure_auth_sessions")

    def setUp(self):
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        apps = executor.loader.project_state([self.migrate_from]).apps
        Member = apps.get_model("authn", "Member")
        EmailAuthChallenge = apps.get_model("authn", "EmailAuthChallenge")

        member = Member.objects.create(
            email="reverse-migration@example.com",
            password="!",
            is_active=True,
            access_level="temporary",
        )
        challenge_values = {
            "member_id": member.pk,
            "purpose": "login",
            "channel": "email",
            "target_email": "reverse-migration@example.com",
            "code_hash": "legacy-code-hash",
            "expires_at": timezone.now() + timedelta(minutes=10),
            "status": "pending",
        }
        EmailAuthChallenge.objects.create(scope_key="event-a:invitation-a", **challenge_values)
        EmailAuthChallenge.objects.create(scope_key="event-b:invitation-b", **challenge_values)

        self.executor = MigrationExecutor(connection)
        self.executor.migrate([self.migrate_to])

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_reverse_migration_expires_duplicate_pending_scopes(self):
        apps = self.executor.loader.project_state([self.migrate_to]).apps
        EmailAuthChallenge = apps.get_model("authn", "EmailAuthChallenge")
        challenges = EmailAuthChallenge.objects.filter(target_email="reverse-migration@example.com")

        self.assertEqual(challenges.filter(status="pending").count(), 1)
        self.assertEqual(challenges.filter(status="expired").count(), 1)
