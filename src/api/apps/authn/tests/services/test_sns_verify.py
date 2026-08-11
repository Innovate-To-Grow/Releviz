from datetime import timedelta
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.authn.models import PhoneVerificationChallenge
from apps.authn.services.sms.sns_verify import (
    MAX_SENDS_PER_HOUR,
    MAX_VERIFY_ATTEMPTS,
    VERIFIED_GRANT_TTL_SECONDS,
    PhoneVerificationDeliveryError,
    PhoneVerificationInvalid,
    PhoneVerificationThrottled,
    _get_smsvoice_client,
    _random_code,
    check_phone_verification,
    consume_verified_phone_challenge,
    publish_plain_sms,
    start_phone_verification,
)
from apps.core.models import AWSCredentialConfig, EmailServiceConfig
from apps.core.services.aws.credentials import AwsCredentialsError, resolve_aws_credentials


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class ResolveAwsCredentialsTest(TestCase):
    def setUp(self):
        AWSCredentialConfig.objects.all().delete()
        EmailServiceConfig.objects.all().delete()

    def test_returns_active_aws_credential_config(self):
        AWSCredentialConfig.objects.create(
            name="AWS",
            is_active=True,
            access_key_id="aws-key",
            secret_access_key="aws-secret",
            default_region="us-east-1",
        )

        creds = resolve_aws_credentials("ses")

        self.assertEqual(creds.access_key_id, "aws-key")
        self.assertEqual(creds.region, "us-east-1")

    def test_all_services_share_the_same_region(self):
        AWSCredentialConfig.objects.create(
            name="AWS",
            is_active=True,
            access_key_id="aws-key",
            secret_access_key="aws-secret",
            default_region="us-east-1",
        )

        self.assertEqual(resolve_aws_credentials("ses").region, "us-east-1")
        self.assertEqual(resolve_aws_credentials("sns").region, "us-east-1")
        self.assertEqual(resolve_aws_credentials("bedrock").region, "us-east-1")

    def test_raises_when_no_aws_credentials_even_if_email_exists(self):
        EmailServiceConfig.objects.create(name="Email", is_active=True)

        with self.assertRaises(AwsCredentialsError):
            resolve_aws_credentials()


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class SnsVerifyServiceTest(TestCase):
    phone = "+12065551234"
    origination_number = "+12065550000"

    def setUp(self):
        cache.clear()
        AWSCredentialConfig.objects.all().delete()
        self.aws_config = AWSCredentialConfig.objects.create(
            name="AWS",
            is_active=True,
            access_key_id="aws-key",
            secret_access_key="aws-secret",
            default_region="us-west-2",
            sms_from_number=self.origination_number,
        )

    def _mock_publish(self, mock_boto_client):
        mock_client = MagicMock()
        mock_client.send_text_message.return_value = {"MessageId": "msg-123"}
        mock_boto_client.return_value = mock_client
        return mock_client

    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    @patch("apps.authn.services.sms.sns_verify._random_code", return_value="123456")
    def test_start_phone_verification_sends_sns_message(self, _mock_code, mock_boto_client):
        mock_client = self._mock_publish(mock_boto_client)

        result = start_phone_verification(self.phone)

        self.assertEqual(result["status"], "pending")
        challenge = PhoneVerificationChallenge.objects.get(pk=result["challenge_id"])
        self.assertEqual(challenge.phone_number, self.phone)
        self.assertEqual(challenge.status, PhoneVerificationChallenge.Status.PENDING)
        self.assertIsNotNone(challenge.send_reserved_at)
        self.assertIsNotNone(challenge.sent_at)
        mock_client.send_text_message.assert_called_once()
        send_kwargs = mock_client.send_text_message.call_args.kwargs
        self.assertEqual(send_kwargs["DestinationPhoneNumber"], self.phone)
        self.assertIn("123456", send_kwargs["MessageBody"])
        self.assertEqual(send_kwargs["MessageType"], "TRANSACTIONAL")
        self.assertEqual(send_kwargs["OriginationIdentity"], self.origination_number)

    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    @patch("apps.authn.services.sms.sns_verify._random_code", return_value="123456")
    def test_check_phone_verification_accepts_valid_code(self, _mock_code, mock_boto_client):
        self._mock_publish(mock_boto_client)
        started = start_phone_verification(self.phone)

        result = check_phone_verification(
            None,
            "123456",
            challenge_id=started["challenge_id"],
        )

        self.assertEqual(result.status, PhoneVerificationChallenge.Status.CONSUMED)
        self.assertEqual(result.phone_number, self.phone)

    def test_approved_callback_and_consumption_roll_back_together(self):
        challenge = PhoneVerificationChallenge.objects.create(
            phone_number=self.phone,
            purpose=PhoneVerificationChallenge.Purpose.PHONE_AUTH,
            code_hash=make_password("123456"),
            expires_at=timezone.now() + timedelta(minutes=10),
        )
        member_model = get_user_model()
        initial_member_count = member_model.objects.count()

        def fail_after_member_creation(_challenge):
            member_model.objects.create_user(password="StrongPass123!")
            raise RuntimeError("token creation failed")

        with self.assertRaisesRegex(RuntimeError, "token creation failed"):
            check_phone_verification(
                None,
                "123456",
                challenge_id=challenge.pk,
                approved_callback=fail_after_member_creation,
            )

        challenge.refresh_from_db()
        self.assertEqual(challenge.status, PhoneVerificationChallenge.Status.PENDING)
        self.assertEqual(member_model.objects.count(), initial_member_count)

    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    @patch("apps.authn.services.sms.sns_verify._random_code", return_value="123456")
    def test_verified_grant_is_consumed_once_with_matching_context(self, _mock_code, mock_boto_client):
        self._mock_publish(mock_boto_client)
        member = get_user_model().objects.create_user(password="StrongPass123!")
        context = "event-registration:event-1"
        started = start_phone_verification(
            self.phone,
            purpose=PhoneVerificationChallenge.Purpose.EVENT_REGISTRATION,
            member=member,
            context_identifier=context,
        )

        verified = check_phone_verification(
            self.phone,
            "123456",
            challenge_id=started["challenge_id"],
            purpose=PhoneVerificationChallenge.Purpose.EVENT_REGISTRATION,
            member=member,
            context_identifier=context,
            consume=False,
        )

        self.assertEqual(verified.status, PhoneVerificationChallenge.Status.VERIFIED)
        self.assertIsNotNone(verified.verified_at)
        consumed = consume_verified_phone_challenge(
            phone_number=self.phone,
            purpose=PhoneVerificationChallenge.Purpose.EVENT_REGISTRATION,
            member=member,
            context_identifier=context,
            challenge_id=verified.pk,
        )
        self.assertEqual(consumed.status, PhoneVerificationChallenge.Status.CONSUMED)
        with self.assertRaises(PhoneVerificationInvalid):
            consume_verified_phone_challenge(
                phone_number=self.phone,
                purpose=PhoneVerificationChallenge.Purpose.EVENT_REGISTRATION,
                member=member,
                context_identifier=context,
                challenge_id=verified.pk,
            )

    def test_verified_grant_gets_fresh_expiry_from_successful_verification(self):
        member = get_user_model().objects.create_user(password="StrongPass123!")
        verified_at = timezone.now()
        challenge = PhoneVerificationChallenge.objects.create(
            phone_number=self.phone,
            purpose=PhoneVerificationChallenge.Purpose.EVENT_REGISTRATION,
            member=member,
            context_identifier="event-registration:event-1",
            code_hash=make_password("123456"),
            expires_at=verified_at + timedelta(seconds=1),
        )

        with patch("apps.authn.services.sms.sns_verify.timezone.now", return_value=verified_at):
            verified = check_phone_verification(
                self.phone,
                "123456",
                challenge_id=challenge.pk,
                purpose=PhoneVerificationChallenge.Purpose.EVENT_REGISTRATION,
                member=member,
                context_identifier="event-registration:event-1",
                consume=False,
            )

        expected_expiry = verified_at + timedelta(seconds=VERIFIED_GRANT_TTL_SECONDS)
        self.assertEqual(verified.expires_at, expected_expiry)
        challenge.refresh_from_db()
        self.assertEqual(challenge.expires_at, expected_expiry)

        nearly_expired = expected_expiry - timedelta(seconds=1)
        with patch("apps.authn.services.sms.sns_verify.timezone.now", return_value=nearly_expired):
            consumed = consume_verified_phone_challenge(
                phone_number=self.phone,
                purpose=PhoneVerificationChallenge.Purpose.EVENT_REGISTRATION,
                member=member,
                context_identifier="event-registration:event-1",
                challenge_id=challenge.pk,
            )
        self.assertEqual(consumed.status, PhoneVerificationChallenge.Status.CONSUMED)

    def test_verified_grant_cannot_cross_contexts(self):
        member = get_user_model().objects.create_user(password="StrongPass123!")
        challenge = PhoneVerificationChallenge.objects.create(
            phone_number=self.phone,
            purpose=PhoneVerificationChallenge.Purpose.EVENT_REGISTRATION,
            member=member,
            context_identifier="event-registration:event-1",
            code_hash=make_password("123456"),
            status=PhoneVerificationChallenge.Status.VERIFIED,
            verified_at=timezone.now(),
            expires_at=timezone.now() + timedelta(minutes=10),
        )

        with self.assertRaises(PhoneVerificationInvalid):
            consume_verified_phone_challenge(
                phone_number=self.phone,
                purpose=PhoneVerificationChallenge.Purpose.EVENT_REGISTRATION,
                member=member,
                context_identifier="event-registration:event-2",
                challenge_id=challenge.pk,
            )

        challenge.refresh_from_db()
        self.assertEqual(challenge.status, PhoneVerificationChallenge.Status.VERIFIED)

    def test_check_phone_verification_rejects_invalid_code_and_persists_attempt(self):
        challenge = PhoneVerificationChallenge.objects.create(
            phone_number=self.phone,
            purpose=PhoneVerificationChallenge.Purpose.PHONE_AUTH,
            code_hash=make_password("123456"),
            expires_at=timezone.now() + timedelta(minutes=10),
        )

        with self.assertRaises(PhoneVerificationInvalid):
            check_phone_verification(None, "000000", challenge_id=challenge.pk)

        challenge.refresh_from_db()
        self.assertEqual(challenge.attempts, 1)

    def test_check_phone_verification_throttles_after_max_attempts(self):
        challenge = PhoneVerificationChallenge.objects.create(
            phone_number=self.phone,
            purpose=PhoneVerificationChallenge.Purpose.PHONE_AUTH,
            code_hash=make_password("123456"),
            attempts=MAX_VERIFY_ATTEMPTS - 1,
            max_attempts=MAX_VERIFY_ATTEMPTS,
            expires_at=timezone.now() + timedelta(minutes=10),
        )

        with self.assertRaises(PhoneVerificationThrottled):
            check_phone_verification(None, "000000", challenge_id=challenge.pk)

        challenge.refresh_from_db()
        self.assertEqual(challenge.attempts, MAX_VERIFY_ATTEMPTS)
        self.assertEqual(challenge.status, PhoneVerificationChallenge.Status.EXPIRED)

    def test_consumed_challenge_cannot_be_replayed(self):
        challenge = PhoneVerificationChallenge.objects.create(
            phone_number=self.phone,
            purpose=PhoneVerificationChallenge.Purpose.PHONE_AUTH,
            code_hash=make_password("123456"),
            expires_at=timezone.now() + timedelta(minutes=10),
        )
        check_phone_verification(None, "123456", challenge_id=challenge.pk)

        with self.assertRaises(PhoneVerificationInvalid):
            check_phone_verification(None, "123456", challenge_id=challenge.pk)

    def test_legacy_phone_only_verification_uses_latest_pending_challenge(self):
        challenge = PhoneVerificationChallenge.objects.create(
            phone_number=self.phone,
            purpose=PhoneVerificationChallenge.Purpose.PHONE_AUTH,
            code_hash=make_password("123456"),
            expires_at=timezone.now() + timedelta(minutes=10),
        )

        consumed = check_phone_verification(self.phone, "123456")

        self.assertEqual(consumed.pk, challenge.pk)
        self.assertEqual(consumed.status, PhoneVerificationChallenge.Status.CONSUMED)

    def test_challenge_id_is_scoped_to_purpose(self):
        challenge = PhoneVerificationChallenge.objects.create(
            phone_number=self.phone,
            purpose=PhoneVerificationChallenge.Purpose.PASSWORD_RESET,
            code_hash=make_password("123456"),
            expires_at=timezone.now() + timedelta(minutes=10),
        )

        with self.assertRaises(PhoneVerificationInvalid):
            check_phone_verification(
                None,
                "123456",
                challenge_id=challenge.pk,
                purpose=PhoneVerificationChallenge.Purpose.PHONE_AUTH,
            )

    def test_challenge_id_is_bound_to_member_and_context(self):
        member_model = get_user_model()
        owner = member_model.objects.create_user(password="StrongPass123!")
        other = member_model.objects.create_user(password="StrongPass123!")
        challenge = PhoneVerificationChallenge.objects.create(
            phone_number=self.phone,
            purpose=PhoneVerificationChallenge.Purpose.CONTACT_PHONE_VERIFY,
            member=owner,
            context_identifier="contact-1",
            code_hash=make_password("123456"),
            expires_at=timezone.now() + timedelta(minutes=10),
        )

        with self.assertRaises(PhoneVerificationInvalid):
            check_phone_verification(
                self.phone,
                "123456",
                challenge_id=challenge.pk,
                purpose=PhoneVerificationChallenge.Purpose.CONTACT_PHONE_VERIFY,
                member=other,
                context_identifier="contact-1",
            )
        consumed = check_phone_verification(
            self.phone,
            "123456",
            challenge_id=challenge.pk,
            purpose=PhoneVerificationChallenge.Purpose.CONTACT_PHONE_VERIFY,
            member=owner,
            context_identifier="contact-1",
        )
        self.assertEqual(consumed.pk, challenge.pk)

    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    @patch("apps.authn.services.sms.sns_verify._random_code", return_value="123456")
    def test_start_phone_verification_throttles_send_count(self, _mock_code, mock_boto_client):
        self._mock_publish(mock_boto_client)
        PhoneVerificationChallenge.objects.bulk_create(
            [
                PhoneVerificationChallenge(
                    phone_number=self.phone,
                    purpose=PhoneVerificationChallenge.Purpose.PHONE_AUTH,
                    code_hash=make_password("123456"),
                    status=PhoneVerificationChallenge.Status.EXPIRED,
                    expires_at=timezone.now(),
                    send_reserved_at=timezone.now(),
                )
                for _index in range(MAX_SENDS_PER_HOUR)
            ]
        )

        with self.assertRaises(PhoneVerificationThrottled):
            start_phone_verification(self.phone)

    @patch(
        "apps.authn.services.sms.sns_verify._mark_challenge_sent",
        side_effect=RuntimeError("database unavailable after provider success"),
    )
    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    @patch("apps.authn.services.sms.sns_verify._random_code", return_value="123456")
    def test_provider_success_finalization_failure_preserves_reservation_and_usable_code(
        self,
        _mock_code,
        mock_boto_client,
        _mock_finalize,
    ):
        self._mock_publish(mock_boto_client)
        PhoneVerificationChallenge.objects.bulk_create(
            [
                PhoneVerificationChallenge(
                    phone_number=self.phone,
                    purpose=PhoneVerificationChallenge.Purpose.CONTACT_PHONE_VERIFY,
                    code_hash=make_password("000000"),
                    status=PhoneVerificationChallenge.Status.EXPIRED,
                    expires_at=timezone.now(),
                    send_reserved_at=timezone.now(),
                )
                for _index in range(MAX_SENDS_PER_HOUR - 1)
            ]
        )

        started = start_phone_verification(self.phone)

        challenge = PhoneVerificationChallenge.objects.get(pk=started["challenge_id"])
        self.assertEqual(challenge.status, PhoneVerificationChallenge.Status.SENDING)
        self.assertIsNotNone(challenge.send_reserved_at)
        consumed = check_phone_verification(
            self.phone,
            "123456",
            challenge_id=challenge.pk,
        )
        self.assertEqual(consumed.status, PhoneVerificationChallenge.Status.CONSUMED)
        with self.assertRaises(PhoneVerificationThrottled):
            start_phone_verification(self.phone)

    @patch("apps.core.services.aws.sms.origination_number_available", return_value=False)
    def test_start_phone_verification_requires_origination_number(self, _mock_available):
        self.aws_config.sms_from_number = ""
        self.aws_config.save(update_fields=["sms_from_number"])

        with self.assertRaises(PhoneVerificationDeliveryError):
            start_phone_verification(self.phone)

    @patch("apps.core.services.aws.sms.resolve_origination_number", return_value="+18005550000")
    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    @patch("apps.authn.services.sms.sns_verify._random_code", return_value="123456")
    def test_start_phone_verification_uses_auto_resolved_origination_number(
        self, _mock_code, mock_boto_client, _mock_resolve
    ):
        self.aws_config.sms_from_number = ""
        self.aws_config.save(update_fields=["sms_from_number"])
        mock_client = self._mock_publish(mock_boto_client)

        start_phone_verification(self.phone)

        send_kwargs = mock_client.send_text_message.call_args.kwargs
        self.assertEqual(send_kwargs["OriginationIdentity"], "+18005550000")

    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    @patch("apps.authn.services.sms.sns_verify._random_code", return_value="123456")
    def test_start_phone_verification_maps_invalid_phone_error(self, _mock_code, mock_boto_client):
        mock_client = MagicMock()
        mock_client.send_text_message.side_effect = ClientError(
            {"Error": {"Code": "ValidationException", "Message": "Invalid phone"}},
            "SendTextMessage",
        )
        mock_boto_client.return_value = mock_client

        with self.assertRaises(PhoneVerificationInvalid):
            start_phone_verification(self.phone)

    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    @patch("apps.authn.services.sms.sns_verify._random_code", return_value="123456")
    def test_start_phone_verification_maps_throttling_error(self, _mock_code, mock_boto_client):
        mock_client = MagicMock()
        mock_client.send_text_message.side_effect = ClientError(
            {"Error": {"Code": "ThrottlingException", "Message": "Rate exceeded"}},
            "SendTextMessage",
        )
        mock_boto_client.return_value = mock_client

        with self.assertRaises(PhoneVerificationThrottled):
            start_phone_verification(self.phone)

    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    @patch("apps.authn.services.sms.sns_verify._random_code", return_value="123456")
    def test_start_phone_verification_maps_conflict_to_delivery_error(self, _mock_code, mock_boto_client):
        # ConflictException is an origination-identity/account-state problem, not a bad recipient.
        mock_client = MagicMock()
        mock_client.send_text_message.side_effect = ClientError(
            {"Error": {"Code": "ConflictException", "Message": "Number in conflicting state"}},
            "SendTextMessage",
        )
        mock_boto_client.return_value = mock_client

        with self.assertRaises(PhoneVerificationDeliveryError):
            start_phone_verification(self.phone)


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class SnsVerifyExtraCoverageTest(TestCase):
    phone = "+12065551234"

    def setUp(self):
        cache.clear()
        AWSCredentialConfig.objects.all().delete()
        self.aws_config = AWSCredentialConfig.objects.create(
            name="AWS",
            is_active=True,
            access_key_id="aws-key",
            secret_access_key="aws-secret",
            default_region="us-west-2",
            sms_from_number="+12065550000",
        )

    def test_random_code_is_six_digit_string(self):
        code = _random_code()
        self.assertEqual(len(code), 6)
        self.assertTrue(code.isdigit())

    @patch("apps.authn.services.sms.sns_verify.resolve_aws_credentials")
    def test_get_smsvoice_client_raises_delivery_error_when_no_credentials(self, mock_resolve):
        mock_resolve.side_effect = AwsCredentialsError("missing")
        with self.assertRaises(PhoneVerificationDeliveryError):
            _get_smsvoice_client()

    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    @patch("apps.authn.services.sms.sns_verify._random_code", return_value="123456")
    def test_publish_maps_botocore_error_to_delivery_error(self, _mock_code, mock_boto_client):
        from botocore.exceptions import BotoCoreError

        mock_client = MagicMock()
        mock_client.send_text_message.side_effect = BotoCoreError()
        mock_boto_client.return_value = mock_client

        with self.assertRaises(PhoneVerificationDeliveryError):
            start_phone_verification(self.phone)

    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    @patch("apps.authn.services.sms.sns_verify._random_code", return_value="123456")
    def test_publish_maps_unknown_client_error_to_delivery_error(self, _mock_code, mock_boto_client):
        mock_client = MagicMock()
        mock_client.send_text_message.side_effect = ClientError(
            {"Error": {"Code": "SomethingElse", "Message": "boom"}},
            "SendTextMessage",
        )
        mock_boto_client.return_value = mock_client

        with self.assertRaises(PhoneVerificationDeliveryError):
            start_phone_verification(self.phone)

    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    def test_start_phone_verification_raises_on_invalid_template(self, mock_boto_client):
        self.aws_config.sms_message_template = "No placeholder here"
        self.aws_config.save(update_fields=["sms_message_template"])

        with self.assertRaises(PhoneVerificationDeliveryError):
            start_phone_verification(self.phone)
        challenge = PhoneVerificationChallenge.objects.get(phone_number=self.phone)
        self.assertEqual(challenge.status, PhoneVerificationChallenge.Status.EXPIRED)
        self.assertIsNotNone(challenge.send_reserved_at)

    def test_check_phone_verification_no_payload_raises_invalid(self):
        with self.assertRaises(PhoneVerificationInvalid):
            check_phone_verification(self.phone, "123456")

    def test_check_phone_verification_already_at_max_attempts_throttles(self):
        challenge = PhoneVerificationChallenge.objects.create(
            phone_number=self.phone,
            purpose=PhoneVerificationChallenge.Purpose.PHONE_AUTH,
            code_hash=make_password("123456"),
            attempts=MAX_VERIFY_ATTEMPTS,
            max_attempts=MAX_VERIFY_ATTEMPTS,
            expires_at=timezone.now() + timedelta(minutes=10),
        )
        with self.assertRaises(PhoneVerificationThrottled):
            check_phone_verification(None, "123456", challenge_id=challenge.pk)
        challenge.refresh_from_db()
        self.assertEqual(challenge.status, PhoneVerificationChallenge.Status.EXPIRED)

    @patch("apps.authn.services.sms.sns_verify.boto3.client")
    def test_publish_plain_sms_sends_message(self, mock_boto_client):
        mock_client = MagicMock()
        mock_client.send_text_message.return_value = {"MessageId": "plain-1"}
        mock_boto_client.return_value = mock_client

        message_id = publish_plain_sms(phone_number=self.phone, message="hello")

        self.assertEqual(message_id, "plain-1")
        mock_client.send_text_message.assert_called_once()

    @patch("apps.core.services.aws.sms.origination_number_available", return_value=False)
    def test_publish_plain_sms_raises_when_not_configured(self, _mock_available):
        self.aws_config.sms_from_number = ""
        self.aws_config.save(update_fields=["sms_from_number"])

        with self.assertRaises(PhoneVerificationDeliveryError):
            publish_plain_sms(phone_number=self.phone, message="hello")


class AwsSmsConfigTest(TestCase):
    def setUp(self):
        AWSCredentialConfig.objects.all().delete()

    def test_is_configured_requires_aws_sns_settings(self):
        AWSCredentialConfig.objects.create(
            name="AWS",
            is_active=True,
            access_key_id="aws-key",
            secret_access_key="aws-secret",
            sms_from_number="+12065550000",
        )
        config = AWSCredentialConfig.load()

        self.assertTrue(config.is_configured)

    @patch("apps.core.services.aws.sms.origination_number_available", return_value=False)
    def test_sns_configured_false_when_no_number_can_be_resolved(self, _mock_available):
        AWSCredentialConfig.objects.create(
            name="AWS",
            is_active=True,
            access_key_id="aws-key",
            secret_access_key="aws-secret",
        )
        config = AWSCredentialConfig.load()

        self.assertFalse(config.sns_configured)

    @patch("apps.core.services.aws.sms.origination_number_available", return_value=True)
    def test_sns_configured_true_when_number_auto_resolved(self, _mock_available):
        AWSCredentialConfig.objects.create(
            name="AWS",
            is_active=True,
            access_key_id="aws-key",
            secret_access_key="aws-secret",
        )
        config = AWSCredentialConfig.load()

        self.assertTrue(config.sns_configured)

    def test_render_otp_message_uses_default_template(self):
        config = AWSCredentialConfig()
        message = config.render_sms_otp_message("654321")
        self.assertIn("654321", message)

    def test_render_otp_message_requires_code_placeholder(self):
        config = AWSCredentialConfig(sms_message_template="Hello there")
        with self.assertRaises(ValueError):
            config.render_sms_otp_message("654321")
