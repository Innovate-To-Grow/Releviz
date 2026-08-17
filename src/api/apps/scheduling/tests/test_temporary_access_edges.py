import hashlib
import uuid
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase
from django.utils import timezone
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.authn.security import RateLimitDecision
from apps.authn.services import start_registration
from apps.authn.tests.helpers import create_member, token_for
from apps.mail.services import EmailDeliveryError
from apps.scheduling.models import (
    Event,
    EventInvitation,
    Participant,
    TemporaryEventSession,
    UserEvent,
    Weight,
)
from apps.scheduling.services import ManagedParticipantError
from apps.scheduling.temp_access import (
    _invitation_and_participant,
    temporary_access_rate_identity,
    temporary_session_from_request,
    temporary_session_member_has_full_access,
    verify_temporary_access_code,
)
from apps.scheduling.views import (
    EventInvitationsView,
    EventRemindersView,
    ManagedParticipantView,
)


class TemporaryAccessEdgeFixture(TestCase):
    def setUp(self):
        self.organizer = create_member("edge-owner@example.com", "Edge", "Owner")
        self.temporary = create_member(
            "edge-temp@example.com",
            "Temp",
            "Member",
            access_level="temporary",
            contact_verified=False,
        )
        self.temporary.set_unusable_password()
        self.temporary.save(update_fields=["password"])
        self.event = Event.objects.create(
            code="TEDGE123",
            name="Temporary access edge cases",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            access_mode="open_link",
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            participant_view_permission="own_only",
        )
        self.participant = Participant.objects.create(
            event=self.event,
            member=self.temporary,
            participant_name="Temporary Person",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        self.invitation = EventInvitation.objects.create(
            event=self.event,
            member=self.temporary,
            email="edge-temp@example.com",
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
            last_sent_at=timezone.now(),
        )
        self.secret = "temporary-edge-secret"
        self.session = TemporaryEventSession.objects.create(
            member=self.temporary,
            participant=self.participant,
            invitation=self.invitation,
            secret_hash=hashlib.sha256(self.secret.encode()).hexdigest(),
            expires_at=timezone.now() + timedelta(days=7),
        )

    def session_cookie(self):
        return f"{self.session.pk}.{self.secret}"

    def temp_client(self):
        client = APIClient()
        client.cookies[settings.TEMP_EVENT_COOKIE_NAME] = self.session_cookie()
        return client

    def organizer_client(self):
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(self.organizer)}")
        return client


class TemporaryAccessServiceEdgeTests(TemporaryAccessEdgeFixture):
    def test_rate_limit_identity_canonicalizes_equivalent_event_link_tokens(self):
        token = self.invitation.access_token
        canonical = temporary_access_rate_identity(self.event.code, token)
        self.assertEqual(
            canonical,
            temporary_access_rate_identity(self.event.code.lower(), f"{{{token}}}"),
        )
        self.assertEqual(
            canonical,
            temporary_access_rate_identity(f" {self.event.code} ", token.hex.upper()),
        )
        self.assertEqual(
            temporary_access_rate_identity(self.event.code, " NOT-A-UUID "),
            temporary_access_rate_identity(self.event.code.lower(), "not-a-uuid"),
        )

    def test_invitation_lookup_rejects_malformed_tokens_and_missing_participants(self):
        self.assertEqual(
            _invitation_and_participant(event_code=self.event.code, access_token=[]), (None, None)
        )

        second_temp = create_member(
            "no-participant@example.com",
            access_level="temporary",
            contact_verified=False,
        )
        orphan_invitation = EventInvitation.objects.create(
            event=self.event,
            member=second_temp,
            email="no-participant@example.com",
            first_sent_at=timezone.now(),
        )
        self.assertEqual(
            _invitation_and_participant(
                event_code=self.event.code,
                access_token=orphan_invitation.access_token,
            ),
            (None, None),
        )

    def test_verification_rejects_unknown_invitation_and_cross_member_challenge(self):
        request = RequestFactory().post("/events/temp-access/verify", HTTP_USER_AGENT="Edge")
        self.assertIsNone(
            verify_temporary_access_code(
                event_code=self.event.code,
                access_token="not-a-token",
                code="123456",
                request=request,
            )
        )

        other = create_member("mismatch@example.com")
        with patch(
            "apps.scheduling.temp_access.verify_email_challenge",
            return_value=SimpleNamespace(member_id=other.pk),
        ):
            self.assertIsNone(
                verify_temporary_access_code(
                    event_code=self.event.code,
                    access_token=self.invitation.access_token,
                    code="123456",
                    request=request,
                )
            )
        self.assertEqual(TemporaryEventSession.objects.count(), 1)

    def test_session_parser_rejects_bad_or_unknown_ids_and_revokes_upgraded_accounts(self):
        cookie_name = settings.TEMP_EVENT_COOKIE_NAME
        malformed = SimpleNamespace(COOKIES={cookie_name: "not-a-uuid.secret"})
        self.assertIsNone(temporary_session_from_request(malformed))
        self.assertFalse(temporary_session_member_has_full_access(malformed))

        unknown = SimpleNamespace(COOKIES={cookie_name: f"{uuid.uuid4()}.secret"})
        self.assertIsNone(temporary_session_from_request(unknown))
        self.assertFalse(temporary_session_member_has_full_access(unknown))

        self.temporary.access_level = "full"
        self.temporary.save(update_fields=["access_level"])
        upgraded = SimpleNamespace(COOKIES={cookie_name: self.session_cookie()})
        self.assertIsNone(temporary_session_from_request(upgraded))
        self.session.refresh_from_db()
        self.assertIsNotNone(self.session.revoked_at)


class TemporaryAccessViewEdgeTests(TemporaryAccessEdgeFixture):
    def test_request_throttle_identities_and_managed_idempotency_validation(self):
        request = SimpleNamespace(user=self.organizer)
        expected_identity = str(self.organizer.pk)
        self.assertEqual(
            ManagedParticipantView().get_auth_rate_identity(request),
            expected_identity,
        )
        self.assertEqual(
            EventInvitationsView().get_auth_rate_identity(request),
            expected_identity,
        )
        self.assertEqual(
            EventRemindersView().get_auth_rate_identity(request),
            expected_identity,
        )

        invalid_key = self.organizer_client().post(
            f"/events/participants/managed?code={self.event.code}",
            {
                "name": "Invalid key",
                "email": "invalid-key@example.com",
                "idempotencyKey": "not-a-uuid",
            },
            format="json",
        )
        self.assertEqual(invalid_key.status_code, 400)
        self.assertEqual(invalid_key.data["error"], "idempotencyKey must be a UUID")

    def test_organizer_roster_metadata_is_locked_with_the_event(self):
        self.event.status = Event.Status.ARCHIVED
        self.event.save(update_fields=["status", "updated_at"])

        response = self.organizer_client().put(
            (
                f"/events/participants/update?code={self.event.code}"
                f"&participantId={self.temporary.pk}"
            ),
            {"groupName": "Locked"},
            format="json",
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["errorCode"], "participant_roster_locked")

    def test_organizer_participant_listing_uses_invitation_private_metadata(self):
        full = create_member("edge-full@example.com", "Full", "Person")
        full_participant = Participant.objects.create(
            event=self.event,
            member=full,
            participant_name="Full Person",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        response = self.organizer_client().get(f"/events/participants?code={self.event.code}")
        self.assertEqual(response.status_code, 200)
        by_id = {item["id"]: item for item in response.data["participants"]}
        self.assertEqual(by_id[str(self.participant.pk)]["invitationStatus"], "invited")
        self.assertEqual(by_id[str(self.participant.pk)]["email"], "edge-temp@example.com")
        self.assertEqual(by_id[str(full_participant.pk)]["accountAccess"], "full")
        self.assertFalse(response.data["scheduleDataIncluded"])

    def test_managed_participant_endpoint_validates_scope_and_service_errors(self):
        client = self.organizer_client()
        self.assertEqual(
            client.post("/events/participants/managed", {}, format="json").status_code, 400
        )
        self.assertEqual(
            client.post(
                "/events/participants/managed?code=UNKNOWN",
                {"name": "Name", "email": "name@example.com"},
                format="json",
            ).status_code,
            404,
        )
        with patch(
            "apps.scheduling.views.create_or_reuse_managed_participant_and_send",
            side_effect=ManagedParticipantError("Organizer only", status_code=403),
        ):
            denied = client.post(
                f"/events/participants/managed?code={self.event.code}",
                {
                    "name": "Name",
                    "email": "name@example.com",
                    "idempotencyKey": str(uuid.uuid4()),
                },
                format="json",
            )
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(denied.data["error"], "Organizer only")

        quota_denied = RateLimitDecision(allowed=False, retry_after=9)
        with (
            patch(
                "apps.scheduling.views.consume_request_rate_limit",
                return_value=quota_denied,
            ),
            patch("apps.scheduling.views.create_or_reuse_managed_participant_and_send") as create,
        ):
            throttled = client.post(
                f"/events/participants/managed?code={self.event.code}",
                {
                    "name": "New person",
                    "email": "new-person@example.com",
                    "idempotencyKey": str(uuid.uuid4()),
                },
                format="json",
            )
        self.assertEqual(throttled.status_code, 429)
        create.assert_not_called()

    def test_managed_participant_creation_rolls_back_when_result_dirty_marking_fails(self):
        client = self.organizer_client()
        email = "managed-atomicity@example.com"
        Member = get_user_model()
        baseline_member_count = Member.objects.count()
        baseline_participant_count = self.event.participants.count()
        baseline_user_event_count = UserEvent.objects.filter(event=self.event).count()

        with (
            patch(
                "apps.scheduling.views.mark_event_results_dirty",
                side_effect=RuntimeError("result invalidation failed"),
            ) as mark_dirty,
            self.assertRaisesMessage(RuntimeError, "result invalidation failed"),
        ):
            client.post(
                f"/events/participants/managed?code={self.event.code}",
                {
                    "name": "Managed Atomicity",
                    "email": email,
                    "idempotencyKey": str(uuid.uuid4()),
                },
                format="json",
            )

        mark_dirty.assert_called_once()
        self.assertEqual(Member.objects.count(), baseline_member_count)
        self.assertEqual(self.event.participants.count(), baseline_participant_count)
        self.assertEqual(
            UserEvent.objects.filter(event=self.event).count(),
            baseline_user_event_count,
        )
        self.assertFalse(ContactEmail.objects.filter(email_address=email).exists())
        self.assertFalse(self.event.invitations.filter(email=email).exists())

    def test_regular_participant_rename_permissions_and_temporary_name_validation(self):
        full = create_member("rename-full@example.com", "Full", "Person")
        full_participant = Participant.objects.create(
            event=self.event,
            member=full,
            participant_name="Full Person",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        self_client = APIClient()
        self_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(full)}")
        self_denied = self_client.put(
            f"/events/participants/update?code={self.event.code}&participantId={full.pk}",
            {"name": "Renamed", "expectedVersion": full_participant.version},
            format="json",
        )
        self.assertEqual(self_denied.status_code, 403)

        organizer = self.organizer_client()
        organizer_denied = organizer.put(
            f"/events/participants/update?code={self.event.code}&participantId={full.pk}",
            {"name": "Renamed", "expectedVersion": full_participant.version},
            format="json",
        )
        self.assertEqual(organizer_denied.status_code, 403)
        self.assertEqual(
            organizer_denied.data["errorCode"],
            "organizer_edit_full_account",
        )
        self.assertEqual(organizer_denied.data["participant"]["accountAccess"], "full")

        endpoint = (
            f"/events/participants/update?code={self.event.code}&participantId={self.temporary.pk}"
        )
        empty = organizer.put(
            endpoint,
            {"name": "  ", "expectedVersion": self.participant.version},
            format="json",
        )
        self.assertEqual(empty.status_code, 400)
        too_long = organizer.put(
            endpoint,
            {"name": "x" * 101, "expectedVersion": self.participant.version},
            format="json",
        )
        self.assertEqual(too_long.status_code, 400)

    def test_code_endpoints_are_non_enumerating_but_enforce_rate_limits(self):
        client = APIClient()
        denied = RateLimitDecision(allowed=False, retry_after=7)
        with patch("apps.scheduling.views.consume_request_rate_limit", return_value=denied):
            requested = client.post(
                "/events/temp-access/request-code",
                {"code": self.event.code, "invitationToken": str(self.invitation.access_token)},
                format="json",
            )
            verified = client.post(
                "/events/temp-access/verify",
                {
                    "code": self.event.code,
                    "invitationToken": str(self.invitation.access_token),
                    "verificationCode": "123456",
                },
                format="json",
            )
        self.assertEqual(requested.status_code, 429)
        self.assertEqual(verified.status_code, 429)

        with patch(
            "apps.scheduling.views.request_temporary_access_code",
            side_effect=RuntimeError("mail provider unavailable"),
        ):
            with self.assertLogs("apps.scheduling.views", level="ERROR"):
                generic = client.post(
                    "/events/temp-access/request-code",
                    {"code": self.event.code, "invitationToken": "opaque"},
                    format="json",
                )
        self.assertEqual(generic.status_code, 202)

    def test_verification_maps_challenge_errors_and_invalid_credentials_to_one_error(self):
        client = APIClient()
        payload = {
            "code": self.event.code,
            "invitationToken": str(self.invitation.access_token),
            "verificationCode": "123456",
        }
        rejected_origin = client.post(
            "/events/temp-access/verify",
            payload,
            format="json",
            HTTP_ORIGIN="https://attacker.example",
        )
        self.assertEqual(rejected_origin.status_code, 403)

        with patch(
            "apps.scheduling.views.verify_temporary_access_code",
            side_effect=DRFValidationError("bad code"),
        ):
            validation_error = client.post("/events/temp-access/verify", payload, format="json")
        self.assertEqual(validation_error.status_code, 400)
        self.assertEqual(validation_error.data["error"], "Invalid or expired verification code.")

        with (
            patch("apps.scheduling.views.verify_temporary_access_code", return_value=None),
            patch("apps.scheduling.views.security_logger.warning") as warning,
        ):
            invalid = client.post("/events/temp-access/verify", payload, format="json")
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.data, validation_error.data)
        self.assertEqual(warning.call_args.args[0], "temporary_access_code_verification_failed")
        self.assertIn("auth_key", warning.call_args.kwargs["extra"])
        self.assertEqual(
            warning.call_args.kwargs["extra"]["auth_scope"],
            "temp_access_code_verify",
        )
        self.assertIn("ip_address", warning.call_args.kwargs["extra"])

    def test_session_endpoint_requires_event_scope_and_hides_results_without_permission(self):
        client = self.temp_client()
        missing = client.get("/events/temp-access/session")
        self.assertEqual(missing.status_code, 400)
        response = client.get(f"/events/temp-access/session?code={self.event.code}")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["canViewResults"])
        self.assertNotIn("results", response.data)

    def test_upgrade_registration_requires_origin_scoped_session_and_member_rate_limit(self):
        endpoint = f"/events/temp-access/upgrade-registration?code={self.event.code}"
        payload = {
            "email": "untrusted@example.com",
            "password": "password123",
            "password_confirm": "password123",
            "first_name": "Formal",
            "last_name": "Name",
        }

        rejected_origin = self.temp_client().post(
            endpoint,
            payload,
            format="json",
            HTTP_ORIGIN="https://attacker.example",
        )
        self.assertEqual(rejected_origin.status_code, 403)
        missing_code = self.temp_client().post(
            "/events/temp-access/upgrade-registration",
            payload,
            format="json",
            HTTP_ORIGIN="http://testserver",
        )
        self.assertEqual(missing_code.status_code, 400)

        with patch("apps.scheduling.views.consume_request_rate_limit") as consume:
            no_session = APIClient().post(
                endpoint,
                payload,
                format="json",
                HTTP_ORIGIN="http://testserver",
            )
        self.assertEqual(no_session.status_code, 401)
        consume.assert_not_called()

        denied = RateLimitDecision(allowed=False, retry_after=7)
        with (
            patch(
                "apps.scheduling.views.consume_request_rate_limit",
                return_value=denied,
            ) as consume,
            patch("apps.scheduling.views.start_registration") as start,
        ):
            throttled = self.temp_client().post(
                endpoint,
                payload,
                format="json",
                HTTP_ORIGIN="http://testserver",
            )
        self.assertEqual(throttled.status_code, 429)
        self.assertEqual(consume.call_args.args[0], "register")
        self.assertEqual(consume.call_args.args[2], str(self.temporary.pk))
        start.assert_not_called()

    def test_upgrade_registration_uses_session_email_and_standard_verify_upgrades_in_place(self):
        endpoint = f"/events/temp-access/upgrade-registration?code={self.event.code}"
        client = self.temp_client()
        untrusted_email = "untrusted@example.com"
        verification_code = "123456"
        with (
            patch(
                "apps.scheduling.views.start_registration",
                wraps=start_registration,
            ) as registration_start,
            patch("apps.scheduling.views.security_logger.info") as log_info,
            patch(
                "apps.authn.services.email.challenges._random_code",
                return_value=verification_code,
            ),
            patch(
                "apps.authn.services.email.send_email.send_verification_email"
            ) as send_verification,
            patch(
                "apps.authn.services.members.register.decrypt_password",
                return_value="new-password-123",
            ),
        ):
            response = client.post(
                endpoint,
                {
                    "email": untrusted_email,
                    "password": "new-password-123",
                    "password_confirm": "new-password-123",
                    "first_name": "Formal",
                    "last_name": "Identity",
                },
                format="json",
                HTTP_ORIGIN="http://testserver",
            )

        self.assertEqual(response.status_code, 202, response.data)
        registration_start.assert_called_once()
        send_verification.assert_called_once()
        self.assertEqual(
            registration_start.call_args.kwargs,
            {"_temporary_upgrade_member_id": self.temporary.pk},
        )
        self.assertEqual(
            registration_start.call_args.args[0]["email"],
            "edge-temp@example.com",
        )
        response_text = response.content.decode()
        self.assertNotIn("edge-temp@example.com", response_text)
        self.assertNotIn(untrusted_email, response_text)
        self.assertEqual(response.wsgi_request.get_full_path(), endpoint)
        self.assertNotIn("email=", response.wsgi_request.get_full_path())
        self.assertIn("no-store", response["Cache-Control"])
        self.assertTrue({"Cookie", "Origin"}.issubset(response["Vary"].split(", ")))

        self.temporary.refresh_from_db()
        self.assertEqual(self.temporary.first_name, "Formal")
        self.assertEqual(self.temporary.last_name, "Identity")
        self.assertEqual(self.temporary.email, "edge-temp@example.com")
        self.assertEqual(self.temporary.access_level, "temporary")
        self.assertTrue(self.temporary.check_password("new-password-123"))
        self.assertFalse(ContactEmail.objects.filter(email_address=untrusted_email).exists())
        challenge = EmailAuthChallenge.objects.get(
            member=self.temporary,
            purpose=EmailAuthChallenge.Purpose.REGISTER,
            status=EmailAuthChallenge.Status.PENDING,
        )
        self.assertEqual(challenge.target_email, "edge-temp@example.com")
        log_info.assert_called_once_with(
            "temporary_upgrade_registration_started",
            extra={
                "event_id": str(self.event.pk),
                "member_id": str(self.temporary.pk),
                "temporary_session_id": str(self.session.pk),
            },
        )
        self.assertNotIn("edge-temp@example.com", str(log_info.call_args))

        verified = client.post(
            "/authn/register/verify-code/",
            {
                "email": "edge-temp@example.com",
                "code": verification_code,
                "temporaryUpgrade": True,
            },
            format="json",
        )
        self.assertEqual(verified.status_code, 200, verified.data)
        self.assertEqual(verified.data["user"]["member_uuid"], str(self.temporary.pk))
        self.temporary.refresh_from_db()
        self.session.refresh_from_db()
        self.participant.refresh_from_db()
        self.assertEqual(self.temporary.access_level, "full")
        self.assertTrue(ContactEmail.objects.get(member=self.temporary).verified)
        self.assertIsNotNone(self.session.revoked_at)
        self.assertEqual(self.participant.member_id, self.temporary.pk)
        self.assertEqual(self.participant.participant_name, "Formal Identity")

    def test_upgrade_registration_errors_do_not_expose_the_session_email(self):
        endpoint = f"/events/temp-access/upgrade-registration?code={self.event.code}"
        payload = {
            "email": "untrusted@example.com",
            "password": "password123",
            "password_confirm": "password123",
            "first_name": "Formal",
            "last_name": "Name",
        }
        with patch(
            "apps.scheduling.views.start_registration",
            side_effect=EmailDeliveryError("edge-temp@example.com delivery failed"),
        ):
            delivery_error = self.temp_client().post(
                endpoint,
                payload,
                format="json",
                HTTP_ORIGIN="http://testserver",
            )
        self.assertEqual(delivery_error.status_code, 503)
        self.assertNotIn("edge-temp@example.com", delivery_error.content.decode())

        with patch(
            "apps.scheduling.views.start_registration",
            side_effect=DRFValidationError({"first_name": "First name is required."}),
        ):
            invalid = self.temp_client().post(
                endpoint,
                payload,
                format="json",
                HTTP_ORIGIN="http://testserver",
            )
        self.assertEqual(invalid.status_code, 400)
        self.assertNotIn("edge-temp@example.com", invalid.content.decode())

        mismatched_member = create_member("upgrade-mismatch@example.com")
        with patch("apps.scheduling.views.start_registration", return_value=mismatched_member):
            with self.assertRaisesRegex(
                RuntimeError,
                "Temporary upgrade registration identity mismatch",
            ):
                self.temp_client().post(
                    endpoint,
                    payload,
                    format="json",
                    HTTP_ORIGIN="http://testserver",
                )

        ContactEmail.objects.filter(member=self.temporary).delete()
        unavailable = self.temp_client().post(
            endpoint,
            payload,
            format="json",
            HTTP_ORIGIN="http://testserver",
        )
        self.assertEqual(unavailable.status_code, 409)
        self.assertNotIn("edge-temp@example.com", unavailable.content.decode())

    def test_participant_endpoint_rejects_missing_scope_session_and_identity_changes(self):
        origin = {"HTTP_ORIGIN": "http://testserver"}
        no_code = self.temp_client().put(
            "/events/temp-access/participant",
            {},
            format="json",
            **origin,
        )
        self.assertEqual(no_code.status_code, 400)
        no_session = APIClient().put(
            f"/events/temp-access/participant?code={self.event.code}",
            {},
            format="json",
            **origin,
        )
        self.assertEqual(no_session.status_code, 401)
        self.assertEqual(no_session.data["errorCode"], "temp_session_inactive")

        immutable = self.temp_client().put(
            f"/events/temp-access/participant?code={self.event.code}",
            {"email": "changed@example.com"},
            format="json",
            **origin,
        )
        self.assertEqual(immutable.status_code, 400)

    def test_participant_endpoint_defensively_rejects_an_account_upgraded_after_authentication(
        self,
    ):
        self.temporary.access_level = "full"
        self.temporary.save(update_fields=["access_level"])
        self.session.member = self.temporary
        client = self.temp_client()
        with patch(
            "apps.scheduling.views.temporary_session_from_request",
            return_value=self.session,
        ):
            response = client.put(
                f"/events/temp-access/participant?code={self.event.code}",
                {},
                format="json",
                HTTP_ORIGIN="http://testserver",
            )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.data["errorCode"], "temp_account_upgraded")
        self.session.refresh_from_db()
        self.assertIsNotNone(self.session.revoked_at)

    def test_participant_endpoint_validates_exclusion_payload_and_version_precondition(self):
        endpoint = f"/events/temp-access/participant?code={self.event.code}"
        origin = {"HTTP_ORIGIN": "http://testserver"}
        client = self.temp_client()

        Weight.objects.create(
            event=self.event,
            participant=self.participant,
            included=False,
        )
        excluded = client.put(
            endpoint,
            {"availabilityInperson": [1, 0], "expectedVersion": 1},
            format="json",
            **origin,
        )
        self.assertEqual(excluded.status_code, 403)
        self.assertEqual(excluded.data["errorCode"], "participant_excluded")
        Weight.objects.all().delete()

        invalid_availability = client.put(
            endpoint,
            {"availabilityInperson": [2], "expectedVersion": 1},
            format="json",
            **origin,
        )
        self.assertEqual(invalid_availability.status_code, 400)
        invalid_submitted = client.put(
            endpoint,
            {"submitted": 2, "expectedVersion": 1},
            format="json",
            **origin,
        )
        self.assertEqual(invalid_submitted.status_code, 400)
        no_updates = client.put(endpoint, {}, format="json", **origin)
        self.assertEqual(no_updates.status_code, 200)
        missing_version = client.put(
            endpoint,
            {"availabilityInperson": [1, 0]},
            format="json",
            **origin,
        )
        self.assertEqual(missing_version.status_code, 428)
        self.assertEqual(missing_version.data["errorCode"], "participant_version_required")
        boolean_version = client.put(
            endpoint,
            {"availabilityInperson": [1, 0], "expectedVersion": True},
            format="json",
            **origin,
        )
        self.assertEqual(boolean_version.status_code, 428)
        idempotent = client.put(
            endpoint,
            {"availabilityInperson": [0, 0], "expectedVersion": 999},
            format="json",
            **origin,
        )
        self.assertEqual(idempotent.status_code, 200)
        self.participant.refresh_from_db()
        self.assertEqual(self.participant.version, 1)

        conflict = client.put(
            endpoint,
            {"availabilityInperson": [1, 0], "expectedVersion": 999},
            format="json",
            **origin,
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.data["errorCode"], "participant_version_conflict")

        self.event.status = Event.Status.CLOSED
        self.event.save(update_fields=["status", "updated_at"])
        locked = client.put(
            endpoint,
            {"availabilityInperson": [1, 0], "expectedVersion": 1},
            format="json",
            **origin,
        )
        self.assertEqual(locked.status_code, 409)
        self.assertEqual(locked.data["errorCode"], "event_responses_locked")

    def test_participant_endpoint_records_submit_withdraw_and_first_draft_transitions(self):
        endpoint = f"/events/temp-access/participant?code={self.event.code}"
        origin = {"HTTP_ORIGIN": "http://testserver"}
        client = self.temp_client()

        submitted = client.put(
            endpoint,
            {"submitted": 1, "expectedVersion": 1},
            format="json",
            **origin,
        )
        self.assertEqual(submitted.status_code, 200)
        self.participant.refresh_from_db()
        self.assertIsNotNone(self.participant.first_submitted_at)
        self.assertIsNotNone(self.participant.last_submitted_at)
        self.invitation.refresh_from_db()
        self.assertEqual(self.invitation.status, EventInvitation.Status.SUBMITTED)

        resubmitted = client.put(
            endpoint,
            {
                "availabilityInperson": [0.5, 0],
                "expectedVersion": self.participant.version,
            },
            format="json",
            **origin,
        )
        self.assertEqual(resubmitted.status_code, 200)
        self.participant.refresh_from_db()

        withdrawn = client.put(
            endpoint,
            {"submitted": 0, "expectedVersion": self.participant.version},
            format="json",
            **origin,
        )
        self.assertEqual(withdrawn.status_code, 200)
        self.participant.refresh_from_db()
        self.assertIsNotNone(self.participant.first_draft_saved_at)
        self.invitation.refresh_from_db()
        self.assertEqual(self.invitation.status, EventInvitation.Status.DRAFT_SAVED)

        self.participant.first_draft_saved_at = None
        self.participant.save(update_fields=["first_draft_saved_at", "updated_at"])
        drafted = client.put(
            endpoint,
            {
                "availabilityInperson": [1, 0],
                "expectedVersion": self.participant.version,
            },
            format="json",
            **origin,
        )
        self.assertEqual(drafted.status_code, 200)
        self.participant.refresh_from_db()
        self.assertIsNotNone(self.participant.first_draft_saved_at)

        repeated_draft = client.put(
            endpoint,
            {
                "availabilityVirtual": [1, 0],
                "expectedVersion": self.participant.version,
            },
            format="json",
            **origin,
        )
        self.assertEqual(repeated_draft.status_code, 200)

    def test_logout_without_an_active_session_remains_idempotent(self):
        response = APIClient().post(
            "/events/temp-access/logout",
            {},
            format="json",
            HTTP_ORIGIN="http://testserver",
        )
        self.assertEqual(response.status_code, 204)
        self.assertEqual(TemporaryEventSession.objects.filter(revoked_at__isnull=True).count(), 1)
