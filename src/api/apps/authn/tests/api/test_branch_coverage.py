"""Focused API and view branch coverage for authn."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.models import ContactEmail

Member = get_user_model()


def _member(*, email: str | None = None, verified=True, **kwargs):
    member = Member.objects.create_user(password="StrongPass123!", **kwargs)
    if email is not None:
        ContactEmail.objects.create(
            member=member,
            email_address=email,
            email_type="primary",
            verified=verified,
        )
    return member


class ContactEmailViewBranchTests(TestCase):
    def test_update_with_no_fields_and_delete_race(self):
        from apps.authn.services.email.challenges import AuthChallengeInvalid
        from apps.authn.views.account import contact_emails as views

        member = _member(is_active=True)
        contact = ContactEmail.objects.create(
            member=member,
            email_address="other@example.com",
            email_type="other",
            verified=False,
        )
        updated, error = views._update_contact_email(member, contact.pk, {})
        self.assertEqual(updated.pk, contact.pk)
        self.assertEqual(error, "")

        request = SimpleNamespace(user=member)
        with patch.object(
            views,
            "delete_contact_email",
            side_effect=AuthChallengeInvalid("deleted concurrently"),
        ):
            response = views.ContactEmailDetailView().delete(request, contact.pk)
        self.assertEqual(response.status_code, 404)


class SessionAndTokenViewBranchTests(APITestCase):
    def setUp(self):
        self.member = _member(email="sessions@example.com", is_active=True)
        self.client.force_authenticate(self.member)

    def test_invalid_refresh_cookie_is_not_current_and_invalid_session_id_is_rejected(self):
        from apps.authn.views.auth.sessions import _current_refresh_jti

        request = SimpleNamespace(
            COOKIES={settings.AUTH_REFRESH_COOKIE_NAME: "invalid"},
            data={},
        )
        with patch(
            "apps.authn.views.auth.sessions.get_refresh_token_from_request",
            return_value="invalid",
        ):
            self.assertEqual(_current_refresh_jti(request), "")

        response = self.client.delete(
            "/authn/sessions/", {"sessionId": "not-a-number"}, format="json"
        )
        self.assertEqual(response.status_code, 400)

    def test_refresh_for_now_inactive_member_is_rejected(self):
        from apps.authn.views.auth.token import PublicTokenRefreshView

        refresh = RefreshToken.for_user(self.member)
        self.member.is_active = False
        self.member.save(update_fields=["is_active"])
        serializer = SimpleNamespace(
            is_valid=lambda **_kwargs: True,
            validated_data={"access": str(refresh.access_token)},
        )
        with patch.object(PublicTokenRefreshView, "get_serializer", return_value=serializer):
            response = self.client.post("/authn/refresh/", {"refresh": str(refresh)}, format="json")
        self.assertEqual(response.status_code, 401)
        self.assertIn("No active account", response.data["detail"])


class UnsubscribeViewBranchTests(APITestCase):
    def test_already_unsubscribed_primary_skips_confirmation_send(self):
        from apps.authn.services.account.unsubscribe import build_unsubscribe_login_token

        member = _member(email="unsubscribed@example.com", is_active=True)
        contact = member.contact_emails.get()
        contact.subscribe = False
        contact.save(update_fields=["subscribe"])
        token = build_unsubscribe_login_token(member)
        with patch(
            "apps.authn.views.account.unsubscribe_login._send_unsubscribe_confirmation"
        ) as send:
            response = self.client.post(
                "/authn/unsubscribe-login/", {"token": token}, format="json"
            )
        self.assertEqual(response.status_code, 200)
        send.assert_not_called()


class AdminLoginHelperBranchTests(TestCase):
    def test_state_without_member_and_hidden_code_without_member(self):
        from apps.authn.views.admin import login_helpers

        request = RequestFactory().get("/admin/login/")
        request.session = {}
        login_helpers.set_admin_login_state(
            request,
            step="email",
            email="user@example.com",
            member_id=None,
        )
        self.assertNotIn(login_helpers._SESSION_MEMBER_ID, request.session)

        request.session[login_helpers._SESSION_HIDE_EMAIL] = True
        with (
            patch.object(login_helpers.admin.site, "each_context", return_value={}),
            patch.object(login_helpers, "render", return_value="rendered") as render,
        ):
            result = login_helpers.render_admin_login(
                request,
                form=object(),
                step="code",
                email="hidden@example.com",
            )
        self.assertEqual(result, "rendered")
        self.assertEqual(render.call_args.args[2]["code_recipient_name"], "")


class EmailCodeCompletionBranchTests(TestCase):
    def test_link_subscriber_without_primary_and_full_active_registration(self):
        from apps.authn.models import EmailAuthChallenge
        from apps.authn.views.auth import email_code

        member = _member(is_active=True, access_level=Member.AccessLevel.FULL)
        email_code._link_email_subscriber(member)
        challenge = SimpleNamespace(
            member_id=member.pk,
            target_email="missing@example.com",
            purpose=EmailAuthChallenge.Purpose.REGISTER,
        )
        payload = email_code._complete_registration(challenge)
        self.assertEqual(payload["message"], "Email verified. Registration successful.")

    def test_temporary_registration_with_empty_display_name_skips_participant_update(self):
        from apps.authn.models import EmailAuthChallenge
        from apps.authn.views.auth import email_code
        from apps.scheduling.models import Participant

        member = _member(
            first_name="",
            last_name="",
            is_active=True,
            access_level=Member.AccessLevel.TEMPORARY,
        )
        challenge = SimpleNamespace(
            member_id=member.pk,
            target_email="missing@example.com",
            purpose=EmailAuthChallenge.Purpose.REGISTER,
        )
        with patch.object(Participant.objects, "filter", wraps=Participant.objects.filter) as query:
            payload = email_code._complete_registration(challenge)
        self.assertEqual(payload["message"], "Email verified. Registration successful.")
        query.assert_not_called()


class ViewHelperBranchTests(TestCase):
    def test_auth_success_response_without_request_skips_origin_check(self):
        from apps.authn.views.helpers import auth_success_response

        with patch("apps.authn.views.helpers.enforce_cookie_request_origin") as enforce:
            response = auth_success_response({"refresh": "refresh-token", "value": 1})
        self.assertEqual(response.data, {"value": 1})
        enforce.assert_not_called()
