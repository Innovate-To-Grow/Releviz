import base64
import os
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.exceptions import ValidationError
from django.core.management import CommandError, call_command
from django.test import RequestFactory, TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.admin import MemberAdmin
from apps.authn.backends import EmailAuthBackend
from apps.authn.forms import AdminPasswordForm
from apps.authn.models import ContactEmail, ContactPhone, EmailAuthChallenge
from apps.authn.services import (
    active_keypair,
    auth_payload,
    complete_registration,
    decrypt_password,
    issue_email_challenge,
    login_with_password,
    normalize_email,
    send_login_alert,
    send_registration_welcome,
    start_registration,
    user_payload,
    validate_password_pair,
    verify_email_challenge,
)
from apps.authn.tests.helpers import create_member, token_for
from apps.authn.views import maybe_debug_code, validation_error_response
from apps.messaging.models import EmailMessageLog
from apps.messaging.services import EmailDeliveryError


def latest_code() -> str:
    body = mail.outbox[-1].body
    return body.split(" is ")[1].split(".")[0]


class AuthServiceAndModelTests(TestCase):
    def setUp(self):
        self.member = create_member("member@example.com", "Mem", "Ber")

    def test_member_and_contact_model_helpers(self):
        self.assertEqual(normalize_email("  USER@Example.COM "), "user@example.com")
        self.assertEqual(self.member.created_at, self.member.date_joined)
        self.assertEqual(self.member.display_name(), "Mem Ber")
        self.assertEqual(self.member.get_username(), "member@example.com")
        self.assertTrue(self.member.can_access_app("missing") is False)
        self.member.admin_apps = ["scheduling"]
        self.assertTrue(self.member.can_access_app("scheduling"))
        self.member.is_superuser = True
        self.assertTrue(self.member.can_access_app("anything"))

        contact = self.member.contact_emails.get()
        self.assertEqual(str(contact), "member@example.com (verified)")
        blank_contact = ContactEmail()
        blank_contact.clean()
        fresh_contact = ContactEmail(email_address=" Fresh@example.com ")
        fresh_contact.clean()
        self.assertEqual(fresh_contact.email_address, "fresh@example.com")
        duplicate = ContactEmail(email_address=" MEMBER@example.com ")
        with self.assertRaises(ValidationError):
            duplicate.clean()

        blank_phone = ContactPhone()
        blank_phone.clean()
        phone = ContactPhone.objects.create(
            member=self.member,
            phone_number="+1 (555) 123-4567",
            region="1-US",
            verified=True,
        )
        phone.clean()
        self.assertEqual(phone.phone_number, "5551234567")
        self.assertEqual(phone.to_e164(), "+15551234567")
        self.assertEqual(str(phone), "+15551234567")

    def test_challenge_lifecycle_and_errors(self):
        issued = issue_email_challenge(
            member=self.member,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="member@example.com",
        )
        self.assertIn("Your Releviz verification code", mail.outbox[-1].body)
        self.assertIn("login -> member@example.com", str(issued.challenge))

        with self.assertRaisesMessage(Exception, "Invalid or expired verification code"):
            verify_email_challenge(
                email="member@example.com",
                code="000000",
                purpose=EmailAuthChallenge.Purpose.PASSWORD_RESET,
            )

        with self.assertRaisesMessage(Exception, "Invalid or expired verification code"):
            verify_email_challenge(
                email="member@example.com",
                code="111111",
                purpose=EmailAuthChallenge.Purpose.LOGIN,
            )
        issued.challenge.refresh_from_db()
        self.assertEqual(issued.challenge.attempts, 1)

        issued.challenge.attempts = issued.challenge.max_attempts
        issued.challenge.save(update_fields=["attempts"])
        with self.assertRaisesMessage(Exception, "Too many verification attempts"):
            verify_email_challenge(
                email="member@example.com",
                code=issued.code,
                purpose=EmailAuthChallenge.Purpose.LOGIN,
            )

        expired = issue_email_challenge(
            member=self.member,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="member@example.com",
        )
        expired.challenge.expires_at = timezone.now() - timedelta(minutes=1)
        expired.challenge.save(update_fields=["expires_at"])
        with self.assertRaisesMessage(Exception, "Invalid or expired verification code"):
            verify_email_challenge(
                email="member@example.com",
                code=expired.code,
                purpose=EmailAuthChallenge.Purpose.LOGIN,
            )

        sms = issue_email_challenge(
            member=self.member,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="",
            target_phone="5551234567",
            channel=EmailAuthChallenge.Channel.SMS,
        )
        self.assertIn("5551234567", str(sms.challenge))
        verified = verify_email_challenge(
            email="",
            code=sms.code,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            consume=False,
        )
        self.assertEqual(verified.status, EmailAuthChallenge.Status.VERIFIED)

    def test_rsa_password_decryption_and_validation(self):
        key = active_keypair()
        self.assertEqual(active_keypair().pk, key.pk)
        self.assertIn("BEGIN PUBLIC KEY", key.public_key_pem)
        self.assertIn("site-encryption", str(key))
        key.save()

        public_key = serialization.load_pem_public_key(key.public_key_pem.encode("utf-8"))
        encrypted = base64.b64encode(
            public_key.encrypt(
                b"password123",
                padding.OAEP(
                    mgf=padding.MGF1(algorithm=hashes.SHA256()),
                    algorithm=hashes.SHA256(),
                    label=None,
                ),
            )
        ).decode("ascii")

        with override_settings(REQUIRE_ENCRYPTED_PASSWORDS=True):
            self.assertEqual(decrypt_password(encrypted, str(key.key_id)), "password123")
            self.assertEqual(
                validate_password_pair({"password": encrypted, "password_confirm": encrypted}),
                "password123",
            )
            with self.assertRaisesMessage(Exception, "Password is required"):
                decrypt_password("", "")
            with self.assertRaisesMessage(Exception, "Unable to decrypt password"):
                decrypt_password("not-base64", str(key.key_id))

        with override_settings(REQUIRE_ENCRYPTED_PASSWORDS=False):
            self.assertEqual(decrypt_password("plain", ""), "plain")
            with self.assertRaisesMessage(Exception, "Passwords do not match"):
                validate_password_pair({"password": "password123", "password_confirm": "other"})
            with self.assertRaisesMessage(Exception, "Password must be at least 8 characters"):
                validate_password_pair({"password": "short", "password_confirm": "short"})

    def test_admin_display_helpers(self):
        member_admin = MemberAdmin(get_user_model(), None)
        self.assertEqual(member_admin.display_name(self.member), "Mem Ber")
        self.assertEqual(member_admin.primary_email(self.member), "member@example.com")

    def test_view_error_and_debug_helpers(self):
        response = validation_error_response(RuntimeError("boom"))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {"detail": "boom"})
        response = validation_error_response(EmailDeliveryError("mail down"))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data, {"detail": "mail down"})
        issued = issue_email_challenge(
            member=self.member,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="member@example.com",
        )
        with override_settings(DEBUG=True):
            self.assertEqual(maybe_debug_code({}, issued), {"debug_code": issued.code})

    def test_best_effort_account_notifications(self):
        self.assertTrue(send_registration_welcome(self.member))
        welcome = EmailMessageLog.objects.get(message_type=EmailMessageLog.MessageType.WELCOME)
        self.assertEqual(welcome.recipient, "member@example.com")
        self.assertIn("Welcome to Releviz", mail.outbox[-1].subject)

        request = RequestFactory().post(
            "/authn/login/",
            HTTP_X_FORWARDED_FOR="203.0.113.10, 10.0.0.1",
            HTTP_USER_AGENT="Browser/1.0",
        )
        self.assertTrue(send_login_alert(self.member, request=request, method="password"))
        alert_body = mail.outbox[-1].body
        self.assertIn("Method: password", alert_body)
        self.assertIn("IP address: 203.0.113.10", alert_body)
        self.assertIn("User agent: Browser/1.0", alert_body)

        request = RequestFactory().post("/authn/login/", HTTP_USER_AGENT="A" * 200)
        self.assertTrue(send_login_alert(self.member, request=request, method="email code"))
        self.assertIn("...", mail.outbox[-1].body)

        self.assertTrue(send_login_alert(self.member, request=None, method="unknown"))
        self.assertIn("IP address: Unknown", mail.outbox[-1].body)

        no_email = get_user_model().objects.create_user(password="password123", is_active=True)
        self.assertFalse(send_registration_welcome(no_email))

        with patch(
            "apps.authn.services.send_email_message",
            side_effect=EmailDeliveryError("notification failed"),
        ):
            self.assertFalse(send_login_alert(self.member, request=None))

    def test_registration_service_branches_and_backend(self):
        with self.assertRaisesMessage(Exception, "Email is required"):
            start_registration({"password": "password123", "password_confirm": "password123"})
        with self.assertRaisesMessage(Exception, "First name is required"):
            start_registration(
                {
                    "email": "new@example.com",
                    "password": "password123",
                    "password_confirm": "password123",
                    "last_name": "User",
                }
            )
        with self.assertRaisesMessage(Exception, "Last name is required"):
            start_registration(
                {
                    "email": "new@example.com",
                    "password": "password123",
                    "password_confirm": "password123",
                    "first_name": "New",
                }
            )
        with self.assertRaisesMessage(Exception, "Unable to register"):
            start_registration(
                {
                    "email": "member@example.com",
                    "password": "password123",
                    "password_confirm": "password123",
                    "first_name": "New",
                    "last_name": "User",
                }
            )

        inactive = get_user_model().objects.create_user(
            email="pending@example.com", password="oldpassword", is_active=False
        )
        ContactEmail.objects.create(
            member=inactive, email_address="pending@example.com", verified=False
        )
        updated = start_registration(
            {
                "email": "pending@example.com",
                "password": "password123",
                "password_confirm": "password123",
                "first_name": "New",
                "last_name": "User",
            }
        )
        self.assertEqual(updated.first_name, "New")
        code = latest_code()
        completed = complete_registration("pending@example.com", code)
        self.assertTrue(completed.is_active)

        backend = EmailAuthBackend()
        self.assertIsNone(backend.authenticate(None))
        self.assertIsNone(backend.authenticate(None, username="missing@example.com", password="x"))
        self.assertIsNone(
            backend.authenticate(None, username="member@example.com", password="wrong")
        )
        self.assertEqual(
            backend.authenticate(None, username="member@example.com", password="password123"),
            self.member,
        )
        with self.assertRaisesMessage(Exception, "Invalid email or password"):
            login_with_password("member@example.com", "wrong")

        payload = user_payload(self.member)
        self.assertEqual(payload["email"], "member@example.com")
        self.assertIn("access", auth_payload(self.member))

    def test_manager_superuser_validation(self):
        with self.assertRaisesMessage(ValueError, "is_staff=True"):
            get_user_model().objects.create_superuser(password="x", is_staff=False)
        with self.assertRaisesMessage(ValueError, "is_superuser=True"):
            get_user_model().objects.create_superuser(password="x", is_superuser=False)


class AuthViewTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.member = create_member("ada@example.com", "Ada", "Lovelace")

    def authenticate(self):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(self.member)}")

    def test_public_key_register_resend_login_and_refresh_flow(self):
        self.assertIn("public_key", self.client.get("/authn/public-key/").data)
        with patch(
            "apps.authn.views.start_registration",
            side_effect=EmailDeliveryError("registration mail failed"),
        ):
            failed_register = self.client.post(
                "/authn/register/",
                {
                    "email": "mailfail@example.com",
                    "password": "password123",
                    "password_confirm": "password123",
                    "first_name": "Mail",
                    "last_name": "Fail",
                },
                format="json",
            )
        self.assertEqual(failed_register.status_code, 503)

        invalid_register = self.client.post(
            "/authn/register/",
            {"email": "bad@example.com", "password": "short", "first_name": "Bad"},
            format="json",
        )
        self.assertEqual(invalid_register.status_code, 400)

        response = self.client.post(
            "/authn/register/",
            {
                "email": "grace@example.com",
                "password": "password123",
                "password_confirm": "password123",
                "first_name": "Grace",
                "last_name": "Hopper",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 202)

        response = self.client.post(
            "/authn/register/resend-code/",
            {"email": "grace@example.com"},
            format="json",
        )
        self.assertEqual(response.status_code, 202)
        with patch(
            "apps.authn.views.issue_email_challenge",
            side_effect=EmailDeliveryError("resend mail failed"),
        ):
            failed_resend = self.client.post(
                "/authn/register/resend-code/",
                {"email": "grace@example.com"},
                format="json",
            )
        self.assertEqual(failed_resend.status_code, 503)

        response = self.client.post(
            "/authn/register/verify-code/",
            {"email": "grace@example.com", "code": latest_code()},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("refresh", response.data)
        self.assertTrue(
            EmailMessageLog.objects.filter(
                recipient="grace@example.com",
                message_type=EmailMessageLog.MessageType.WELCOME,
            ).exists()
        )
        invalid_verify = self.client.post(
            "/authn/register/verify-code/",
            {"email": "grace@example.com", "code": "000000"},
            format="json",
        )
        self.assertEqual(invalid_verify.status_code, 400)

        unable = self.client.post(
            "/authn/register/resend-code/",
            {"email": "grace@example.com"},
            format="json",
        )
        self.assertEqual(unable.status_code, 400)

        bad_login = self.client.post(
            "/authn/login/", {"email": "grace@example.com", "password": "bad"}, format="json"
        )
        self.assertEqual(bad_login.status_code, 400)

        login = self.client.post(
            "/authn/login/",
            {"email": "grace@example.com", "password": "password123"},
            format="json",
        )
        self.assertEqual(login.status_code, 200)
        self.assertTrue(
            EmailMessageLog.objects.filter(
                recipient="grace@example.com",
                message_type=EmailMessageLog.MessageType.LOGIN_ALERT,
            ).exists()
        )
        with patch(
            "apps.authn.services.send_email_message",
            side_effect=EmailDeliveryError("login notification failed"),
        ):
            login = self.client.post(
                "/authn/login/",
                {"email": "grace@example.com", "password": "password123"},
                format="json",
            )
        self.assertEqual(login.status_code, 200)
        refresh = self.client.post(
            "/authn/refresh/", {"refresh": login.data["refresh"]}, format="json"
        )
        self.assertEqual(refresh.status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {login.data['access']}")
        logout_without_refresh = self.client.post("/authn/logout/", {}, format="json")
        self.assertEqual(logout_without_refresh.status_code, 200)
        logout = self.client.post("/authn/logout/", {"refresh": "not-a-token"}, format="json")
        self.assertEqual(logout.status_code, 200)

    def test_code_login_profile_contacts_password_and_delete_endpoints(self):
        unknown = self.client.post(
            "/authn/login/request-code/", {"email": "missing@example.com"}, format="json"
        )
        self.assertEqual(unknown.status_code, 202)

        request_code = self.client.post(
            "/authn/login/request-code/", {"email": "ada@example.com"}, format="json"
        )
        self.assertEqual(request_code.status_code, 202)
        ada_login_code = latest_code()
        with patch(
            "apps.authn.views.issue_email_challenge",
            side_effect=EmailDeliveryError("login code failed"),
        ):
            failed_login_code = self.client.post(
                "/authn/login/request-code/", {"email": "ada@example.com"}, format="json"
            )
        self.assertEqual(failed_login_code.status_code, 503)
        inactive = create_member("inactive@example.com", is_active=False)
        issued = issue_email_challenge(
            member=inactive,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="inactive@example.com",
        )
        inactive_login = self.client.post(
            "/authn/login/verify-code/",
            {"email": "inactive@example.com", "code": issued.code},
            format="json",
        )
        self.assertEqual(inactive_login.status_code, 400)
        bad_code = self.client.post(
            "/authn/login/verify-code/",
            {"email": "ada@example.com", "code": "000000"},
            format="json",
        )
        self.assertEqual(bad_code.status_code, 400)
        login = self.client.post(
            "/authn/login/verify-code/",
            {"email": "ada@example.com", "code": ada_login_code},
            format="json",
        )
        self.assertEqual(login.status_code, 200)
        self.assertTrue(
            EmailMessageLog.objects.filter(
                recipient="ada@example.com",
                message_type=EmailMessageLog.MessageType.LOGIN_ALERT,
            ).exists()
        )
        issued = issue_email_challenge(
            member=self.member,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="ada@example.com",
        )
        with patch(
            "apps.authn.services.send_email_message",
            side_effect=EmailDeliveryError("login code notification failed"),
        ):
            login = self.client.post(
                "/authn/login/verify-code/",
                {"email": "ada@example.com", "code": issued.code},
                format="json",
            )
        self.assertEqual(login.status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {login.data['access']}")

        profile = self.client.get("/authn/profile/")
        self.assertEqual(profile.data["user"]["displayName"], "Ada Lovelace")
        profile = self.client.put(
            "/authn/profile/",
            {
                "firstName": "Augusta",
                "lastName": "King",
                "organization": "Math",
                "title": "Countess",
                "imageUrl": "https://example.com/a.png",
            },
            format="json",
        )
        self.assertEqual(profile.data["user"]["displayName"], "Augusta King")

        self.assertEqual(self.client.get("/authn/account-emails/").status_code, 200)
        empty_email = self.client.post("/authn/account-emails/", {"email": ""}, format="json")
        self.assertEqual(empty_email.status_code, 400)
        second = self.client.post(
            "/authn/account-emails/", {"email": "second@example.com"}, format="json"
        )
        self.assertEqual(second.status_code, 201)
        with patch(
            "apps.authn.views.issue_email_challenge",
            side_effect=EmailDeliveryError("contact email failed"),
        ):
            failed_email = self.client.post(
                "/authn/account-emails/", {"email": "third@example.com"}, format="json"
            )
        self.assertEqual(failed_email.status_code, 503)
        repeat = self.client.post(
            "/authn/account-emails/", {"email": "second@example.com"}, format="json"
        )
        self.assertEqual(repeat.status_code, 200)
        other = create_member("other@example.com")
        conflict = self.client.post("/authn/account-emails/", {"email": other.email}, format="json")
        self.assertEqual(conflict.status_code, 400)

        self.assertEqual(self.client.get("/authn/contact-phones/").status_code, 200)
        empty_phone = self.client.post("/authn/contact-phones/", {"phone": ""}, format="json")
        self.assertEqual(empty_phone.status_code, 400)
        phone = self.client.post(
            "/authn/contact-phones/",
            {"phone": "+1 (555) 123-4567", "region": "1-US"},
            format="json",
        )
        self.assertEqual(phone.status_code, 201)
        same_phone = self.client.post(
            "/authn/contact-phones/",
            {"phone": "5551234567", "region": "1-US"},
            format="json",
        )
        self.assertEqual(same_phone.status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(other)}")
        phone_conflict = self.client.post(
            "/authn/contact-phones/", {"phone": "5551234567"}, format="json"
        )
        self.assertEqual(phone_conflict.status_code, 400)

        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {login.data['access']}")
        phone_auth = self.client.post("/authn/phone-auth/request-code/", {}, format="json")
        self.assertEqual(phone_auth.status_code, 501)
        self.assertEqual(
            self.client.post("/authn/phone-auth/verify-code/", {}, format="json").status_code, 501
        )

        reset_unknown = self.client.post(
            "/authn/password-reset/request-code/",
            {"email": "missing@example.com"},
            format="json",
        )
        self.assertEqual(reset_unknown.status_code, 202)
        reset = self.client.post(
            "/authn/password-reset/request-code/", {"email": "ada@example.com"}, format="json"
        )
        self.assertEqual(reset.status_code, 202)
        with patch(
            "apps.authn.views.issue_email_challenge",
            side_effect=EmailDeliveryError("reset mail failed"),
        ):
            failed_reset = self.client.post(
                "/authn/password-reset/request-code/",
                {"email": "ada@example.com"},
                format="json",
            )
        self.assertEqual(failed_reset.status_code, 503)
        bad_reset = self.client.post(
            "/authn/password-reset/confirm/",
            {"email": "ada@example.com", "code": "000000", "password": "password456"},
            format="json",
        )
        self.assertEqual(bad_reset.status_code, 400)
        good_reset = self.client.post(
            "/authn/password-reset/confirm/",
            {
                "email": "ada@example.com",
                "code": latest_code(),
                "password": "password456",
                "password_confirm": "password456",
            },
            format="json",
        )
        self.assertEqual(good_reset.status_code, 200)

        wrong_change = self.client.post(
            "/authn/change-password/",
            {"current_password": "wrong", "new_password": "password789"},
            format="json",
        )
        self.assertEqual(wrong_change.status_code, 400)
        bad_change = self.client.post(
            "/authn/change-password/",
            {
                "current_password": "password456",
                "new_password": "password789",
                "new_password_confirm": "different789",
            },
            format="json",
        )
        self.assertEqual(bad_change.status_code, 400)
        change = self.client.post(
            "/authn/change-password/",
            {
                "current_password": "password456",
                "new_password": "password789",
                "new_password_confirm": "password789",
            },
            format="json",
        )
        self.assertEqual(change.status_code, 200)

        delete = self.client.post("/authn/delete-account/", {"refresh": "bad"}, format="json")
        self.assertEqual(delete.status_code, 200)
        self.member.refresh_from_db()
        self.assertFalse(self.member.is_active)
        no_refresh_member = create_member("delete-no-refresh@example.com")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(no_refresh_member)}")
        self.assertEqual(
            self.client.post("/authn/delete-account/", {}, format="json").status_code,
            200,
        )

    def test_admin_login_form_and_view_branches(self):
        staff = create_member("staff@example.com", is_staff=True, is_superuser=True)
        form = AdminPasswordForm(data={"email": "staff@example.com", "password": "password123"})
        self.assertTrue(form.is_valid())
        self.assertEqual(form.get_user(), staff)
        invalid = AdminPasswordForm(data={"email": "ada@example.com", "password": "password123"})
        self.assertFalse(invalid.is_valid())
        missing_password = AdminPasswordForm(data={"email": "staff@example.com"})
        self.assertFalse(missing_password.is_valid())

        response = self.client.post(
            "/admin/login/?next=/admin/",
            {"email": "staff@example.com", "password": "password123", "next": "/admin/"},
        )
        self.assertEqual(response.status_code, 302)
        response = self.client.get("/admin/login/?next=/admin/")
        self.assertEqual(response.status_code, 302)
        response = self.client.post("/admin/login/", {"next": "/admin/"})
        self.assertEqual(response.status_code, 302)
        self.client.logout()
        response = self.client.post(
            "/admin/login/?next=/admin/",
            {"email": "staff@example.com", "password": "wrong", "next": "/admin/"},
        )
        self.assertEqual(response.status_code, 400)
        response = self.client.post(
            "/admin/login/?next=https://evil.example/",
            {
                "email": "staff@example.com",
                "password": "password123",
                "next": "https://evil.example/",
            },
        )
        self.assertEqual(response["Location"], "/admin/")

    def test_default_admin_command_create_update_and_errors(self):
        with self.assertRaises(CommandError):
            call_command("ensure_default_admin", email="admin@example.com")
        with self.assertRaises(CommandError):
            call_command("ensure_default_admin", "--yes", email="")
        with self.assertRaises(CommandError):
            call_command("ensure_default_admin", "--yes", email="admin@example.com")

        with patch.dict(os.environ, {"DJANGO_SUPERUSER_PASSWORD": "password123"}):
            output = StringIO()
            call_command("ensure_default_admin", "--yes", email="admin@example.com", stdout=output)
            self.assertIn("created", output.getvalue())
            output = StringIO()
            call_command(
                "ensure_default_admin",
                "--yes",
                email="admin@example.com",
                first_name="Updated",
                stdout=output,
            )
            self.assertIn("updated", output.getvalue())
