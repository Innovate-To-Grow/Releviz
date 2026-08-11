import uuid
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.test import RequestFactory, TestCase, override_settings
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied
from rest_framework.test import APIClient, APIRequestFactory
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.admin import revoke_selected_sessions
from apps.authn.authentication import SessionJWTAuthentication
from apps.authn.models import AuthRateLimitBucket, AuthSession, EmailAuthChallenge
from apps.authn.security import (
    AuthRateThrottle,
    clear_password_login_failures,
    client_ip,
    consume_request_rate_limit,
    enforce_cookie_request_origin,
    normalize_security_identity,
    password_login_allowed,
    prune_auth_security_state,
    record_password_login_failure,
)
from apps.authn.services import (
    issue_auth_session,
    issue_email_challenge,
    login_with_password,
    revoke_all_auth_sessions,
    revoke_auth_session,
    revoke_refresh_session,
    rotate_auth_session,
)
from apps.authn.tests.helpers import create_member
from apps.messaging.models import EmailDeliveryJob


class AuthSessionSecurityTests(TestCase):
    def setUp(self):
        self.member = create_member("secure@example.com", "Secure", "User")
        self.factory = RequestFactory()

    def test_session_models_and_session_bound_authentication(self):
        request = self.factory.post(
            "/authn/login/",
            REMOTE_ADDR="203.0.113.7",
            HTTP_USER_AGENT="Browser/1.0",
        )
        issued = issue_auth_session(self.member, request=request)
        session = issued.session
        self.assertTrue(session.active)
        self.assertIn("active", str(session))
        self.assertEqual(session.ip_address, "203.0.113.7")
        self.assertEqual(session.user_agent, "Browser/1.0")
        self.assertNotIn("refresh", issued.payload)

        authentication = SessionJWTAuthentication()
        validated = authentication.get_validated_token(issued.payload["access"])
        self.assertEqual(authentication.get_user(validated), self.member)

        legacy = RefreshToken.for_user(self.member)
        with self.assertRaisesMessage(AuthenticationFailed, "Session is invalid"):
            authentication.get_user(legacy.access_token)
        legacy["session_id"] = "not-a-uuid"
        with self.assertRaisesMessage(AuthenticationFailed, "Session is invalid"):
            authentication.get_user(legacy.access_token)

        self.assertTrue(session.revoke(AuthSession.RevocationReason.LOGOUT))
        self.assertFalse(session.revoke(AuthSession.RevocationReason.LOGOUT))
        self.assertFalse(session.active)
        self.assertIn("revoked/expired", str(session))
        with self.assertRaisesMessage(AuthenticationFailed, "no longer active"):
            authentication.get_user(validated)

        expired = issue_auth_session(self.member).session
        expired.expires_at = timezone.now() - timedelta(seconds=1)
        expired.save(update_fields=["expires_at"])
        self.assertFalse(expired.active)

        bucket = AuthRateLimitBucket.objects.create(scope="test", key_hash="a" * 64)
        self.assertIn("test:aaaaaaaaaaaa", str(bucket))

    def test_issue_rotate_replay_and_revocation_paths(self):
        self.member.is_active = False
        self.member.save(update_fields=["is_active"])
        with self.assertRaisesMessage(Exception, "Account is inactive"):
            issue_auth_session(self.member)
        self.member.is_active = True
        self.member.save(update_fields=["is_active"])

        with self.assertRaises(TokenError):
            rotate_auth_session("")
        with self.assertRaises(TokenError):
            rotate_auth_session("not-a-token")

        issued = issue_auth_session(self.member)
        first_refresh = issued.refresh_token
        rotated = rotate_auth_session(first_refresh)
        self.assertEqual(rotated.session.pk, issued.session.pk)
        self.assertNotEqual(rotated.refresh_token, first_refresh)
        with self.assertRaises(TokenError):
            rotate_auth_session(first_refresh)

        self.assertFalse(revoke_refresh_session("", AuthSession.RevocationReason.LOGOUT))
        self.assertFalse(revoke_refresh_session("not-a-token", AuthSession.RevocationReason.LOGOUT))

        no_session_token = RefreshToken.for_user(self.member)
        self.assertFalse(
            revoke_refresh_session(
                str(no_session_token),
                AuthSession.RevocationReason.LOGOUT,
            )
        )

        with patch.object(RefreshToken, "blacklist", side_effect=TokenError("already invalid")):
            self.assertTrue(
                revoke_refresh_session(
                    rotated.refresh_token,
                    AuthSession.RevocationReason.LOGOUT,
                )
            )

        another = issue_auth_session(self.member)
        self.assertEqual(
            revoke_all_auth_sessions(self.member, AuthSession.RevocationReason.ADMIN),
            1,
        )
        another.session.refresh_from_db()
        self.assertEqual(another.session.revoked_reason, AuthSession.RevocationReason.ADMIN)

    def test_lost_refresh_response_has_bounded_same_client_recovery(self):
        request = self.factory.post(
            "/authn/refresh/",
            REMOTE_ADDR="203.0.113.20",
            HTTP_USER_AGENT="Recovery Browser/1.0",
        )
        issued = issue_auth_session(self.member, request=request)
        rotated = rotate_auth_session(issued.refresh_token, request=request)
        recovered = rotate_auth_session(issued.refresh_token, request=request)
        self.assertEqual(recovered.refresh_token, rotated.refresh_token)
        self.assertEqual(recovered.session.pk, issued.session.pk)
        recovered.session.refresh_from_db()
        self.assertEqual(
            recovered.session.previous_refresh_jti,
            str(RefreshToken(issued.refresh_token, verify=False)[api_settings.JTI_CLAIM]),
        )
        self.assertIsNotNone(recovered.session.refresh_recovered_at)
        with self.assertRaises(TokenError):
            rotate_auth_session(issued.refresh_token, request=request)

        different_ip = self.factory.post(
            "/authn/refresh/",
            REMOTE_ADDR="203.0.113.21",
            HTTP_USER_AGENT="Recovery Browser/1.0",
        )
        ip_session = issue_auth_session(self.member, request=request)
        rotate_auth_session(ip_session.refresh_token, request=request)
        with self.assertRaises(TokenError):
            rotate_auth_session(ip_session.refresh_token, request=different_ip)

        different_agent = self.factory.post(
            "/authn/refresh/",
            REMOTE_ADDR="203.0.113.20",
            HTTP_USER_AGENT="Different Browser/2.0",
        )
        agent_session = issue_auth_session(self.member, request=request)
        rotate_auth_session(agent_session.refresh_token, request=request)
        with self.assertRaises(TokenError):
            rotate_auth_session(agent_session.refresh_token, request=different_agent)

        expired = issue_auth_session(self.member, request=request)
        rotate_auth_session(expired.refresh_token, request=request)
        expired.session.refresh_from_db()
        expired.session.refresh_recovery_expires_at = timezone.now() - timedelta(seconds=1)
        expired.session.save(update_fields=["refresh_recovery_expires_at"])
        with self.assertRaises(TokenError):
            rotate_auth_session(expired.refresh_token, request=request)

        missing_current = issue_auth_session(self.member, request=request)
        rotate_auth_session(missing_current.refresh_token, request=request)
        missing_current.session.refresh_from_db()
        OutstandingToken.objects.filter(jti=missing_current.session.refresh_jti).delete()
        with self.assertRaises(TokenError):
            rotate_auth_session(missing_current.refresh_token, request=request)

        mismatched_current = issue_auth_session(self.member, request=request)
        rotate_auth_session(mismatched_current.refresh_token, request=request)
        mismatched_current.session.refresh_from_db()
        wrong_current = RefreshToken.for_user(self.member)
        wrong_current["session_id"] = str(uuid.uuid4())
        mismatched_current.session.refresh_jti = str(wrong_current[api_settings.JTI_CLAIM])
        mismatched_current.session.save(update_fields=["refresh_jti"])
        OutstandingToken.objects.filter(jti=mismatched_current.session.refresh_jti).update(
            token=str(wrong_current)
        )
        with self.assertRaises(TokenError):
            rotate_auth_session(mismatched_current.refresh_token, request=request)

    def test_rotate_rejects_server_side_session_mismatches(self):
        missing = issue_auth_session(self.member)
        missing.session.delete()
        with self.assertRaises(TokenError):
            rotate_auth_session(missing.refresh_token)

        revoked = issue_auth_session(self.member)
        revoked.session.revoke(AuthSession.RevocationReason.LOGOUT)
        with self.assertRaises(TokenError):
            rotate_auth_session(revoked.refresh_token)

        expired = issue_auth_session(self.member)
        expired.session.expires_at = timezone.now() - timedelta(seconds=1)
        expired.session.save(update_fields=["expires_at"])
        with self.assertRaises(TokenError):
            rotate_auth_session(expired.refresh_token)

        wrong_jti = issue_auth_session(self.member)
        wrong_jti.session.refresh_jti = "different"
        wrong_jti.session.save(update_fields=["refresh_jti"])
        with self.assertRaises(TokenError):
            rotate_auth_session(wrong_jti.refresh_token)

        other = create_member("other-secure@example.com")
        wrong_user = issue_auth_session(self.member)
        other_refresh = RefreshToken.for_user(other)
        other_refresh["session_id"] = str(wrong_user.session.pk)
        wrong_user.session.refresh_jti = str(other_refresh[api_settings.JTI_CLAIM])
        wrong_user.session.save(update_fields=["refresh_jti"])
        with self.assertRaises(TokenError):
            rotate_auth_session(str(other_refresh))

        inactive = issue_auth_session(self.member)
        self.member.is_active = False
        self.member.save(update_fields=["is_active"])
        with self.assertRaisesMessage(TokenError, "inactive"):
            rotate_auth_session(inactive.refresh_token)
        self.member.is_active = True
        self.member.save(update_fields=["is_active"])

        changed = issue_auth_session(self.member)
        self.member.set_password("new-password-123")
        self.member.save(update_fields=["password"])
        with self.assertRaisesMessage(TokenError, "credentials changed"):
            rotate_auth_session(changed.refresh_token)

    def test_cookie_api_rotation_origin_and_immediate_logout_revocation(self):
        client = APIClient()
        login = client.post(
            "/authn/login/",
            {"email": "secure@example.com", "password": "password123"},
            format="json",
        )
        self.assertEqual(login.status_code, 200)
        access = login.data["access"]
        self.assertEqual(login["Cache-Control"], "no-store")
        self.assertEqual(login["Pragma"], "no-cache")

        denied_origin = client.post(
            "/authn/refresh/",
            {},
            format="json",
            HTTP_ORIGIN="https://evil.example",
        )
        self.assertEqual(denied_origin.status_code, 403)

        refreshed = client.post(
            "/authn/refresh/",
            {},
            format="json",
            HTTP_ORIGIN="http://testserver",
        )
        self.assertEqual(refreshed.status_code, 200)

        client.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")
        self.assertEqual(client.post("/authn/logout/", {}, format="json").status_code, 200)
        self.assertEqual(client.get("/authn/profile/").status_code, 401)

        client.credentials()
        client.cookies.clear()
        unavailable = client.post("/authn/refresh/", {}, format="json")
        self.assertEqual(unavailable.status_code, 401)
        self.assertEqual(unavailable["Cache-Control"], "no-store")
        self.assertEqual(client.cookies["releviz_refresh"].value, "")

    @override_settings(AUTH_REFRESH_COOKIE_SECURE=True)
    def test_secure_cookie_flag_and_admin_revocation_action(self):
        client = APIClient()
        login = client.post(
            "/authn/login/",
            {"email": "secure@example.com", "password": "password123"},
            format="json",
        )
        self.assertTrue(login.cookies["releviz_refresh"]["secure"])
        session = AuthSession.objects.get(pk=login.data["session"]["id"])
        revoke_selected_sessions(
            None,
            None,
            AuthSession.objects.filter(pk=session.pk),
        )
        session.refresh_from_db()
        self.assertEqual(session.revoked_reason, AuthSession.RevocationReason.ADMIN)

    def test_user_can_list_revoke_and_sign_out_all_sessions(self):
        first_client = APIClient()
        second_client = APIClient()
        first_login = first_client.post(
            "/authn/login/",
            {"email": "secure@example.com", "password": "password123"},
            format="json",
        )
        second_login = second_client.post(
            "/authn/login/",
            {"email": "secure@example.com", "password": "password123"},
            format="json",
        )
        first_client.credentials(HTTP_AUTHORIZATION=f"Bearer {first_login.data['access']}")
        second_client.credentials(HTTP_AUTHORIZATION=f"Bearer {second_login.data['access']}")

        sessions = first_client.get("/authn/sessions/")
        self.assertEqual(sessions.status_code, 200)
        self.assertEqual(len(sessions.data["sessions"]), 2)
        current = next(item for item in sessions.data["sessions"] if item["current"])
        other = next(item for item in sessions.data["sessions"] if not item["current"])
        self.assertEqual(current["id"], first_login.data["session"]["id"])
        self.assertIn("lastSeenAt", other)

        invalid = first_client.delete(
            "/authn/sessions/",
            {"sessionId": "not-a-uuid"},
            format="json",
        )
        self.assertEqual(invalid.status_code, 400)
        missing = first_client.delete(
            "/authn/sessions/",
            {"sessionId": str(uuid.uuid4())},
            format="json",
        )
        self.assertEqual(missing.status_code, 404)
        orphan = AuthSession.objects.create(
            member=self.member,
            refresh_jti="orphan-refresh-jti",
            expires_at=timezone.now() + timedelta(days=1),
        )
        self.assertEqual(
            revoke_auth_session(
                self.member,
                orphan.pk,
                AuthSession.RevocationReason.SESSION_REVOKE,
            ),
            orphan,
        )

        revoked = first_client.delete(
            "/authn/sessions/",
            {"sessionId": other["id"]},
            format="json",
        )
        self.assertEqual(revoked.status_code, 200)
        self.assertFalse(revoked.data["currentRevoked"])
        self.assertEqual(second_client.get("/authn/profile/").status_code, 401)

        current_revoke = first_client.delete(
            "/authn/sessions/",
            {"sessionId": current["id"]},
            format="json",
        )
        self.assertTrue(current_revoke.data["currentRevoked"])
        self.assertEqual(first_client.cookies["releviz_refresh"].value, "")

        third_client = APIClient()
        third_login = third_client.post(
            "/authn/login/",
            {"email": "secure@example.com", "password": "password123"},
            format="json",
        )
        issue_auth_session(self.member)
        third_client.credentials(HTTP_AUTHORIZATION=f"Bearer {third_login.data['access']}")
        all_revoked = third_client.delete("/authn/sessions/", {"all": True}, format="json")
        self.assertEqual(all_revoked.status_code, 200)
        self.assertGreaterEqual(all_revoked.data["revoked"], 2)
        self.assertTrue(all_revoked.data["currentRevoked"])
        self.assertEqual(third_client.get("/authn/profile/").status_code, 401)

    def test_prunes_only_stale_security_state(self):
        now = timezone.now()
        stale_bucket = AuthRateLimitBucket.objects.create(scope="stale", key_hash="b" * 64)
        AuthRateLimitBucket.objects.filter(pk=stale_bucket.pk).update(
            updated_at=now - timedelta(days=8)
        )
        fresh_bucket = AuthRateLimitBucket.objects.create(scope="fresh", key_hash="c" * 64)

        stale_session = issue_auth_session(self.member).session
        stale_session.expires_at = now - timedelta(days=31)
        stale_session.save(update_fields=["expires_at"])
        fresh_session = issue_auth_session(self.member).session
        expired_challenge = issue_email_challenge(
            member=self.member,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="secure@example.com",
        )
        expired_challenge.challenge.expires_at = now - timedelta(seconds=1)
        expired_challenge.challenge.save(update_fields=["expires_at", "updated_at"])

        result = prune_auth_security_state(now=now)
        self.assertGreaterEqual(result["rateLimitBuckets"], 1)
        self.assertGreaterEqual(result["sessions"], 1)
        self.assertEqual(result["outstandingTokens"], 0)
        self.assertEqual(result["authChallenges"], 1)
        self.assertEqual(result["authEmailJobs"], 1)
        self.assertFalse(AuthRateLimitBucket.objects.filter(pk=stale_bucket.pk).exists())
        self.assertTrue(AuthRateLimitBucket.objects.filter(pk=fresh_bucket.pk).exists())
        self.assertFalse(AuthSession.objects.filter(pk=stale_session.pk).exists())
        self.assertTrue(AuthSession.objects.filter(pk=fresh_session.pk).exists())
        expired_challenge.challenge.refresh_from_db()
        expired_challenge.delivery_job.refresh_from_db()
        self.assertEqual(
            expired_challenge.challenge.status,
            EmailAuthChallenge.Status.EXPIRED,
        )
        self.assertEqual(
            expired_challenge.delivery_job.status,
            EmailDeliveryJob.Status.CANCELED,
        )


SMALL_REQUEST_LIMITS = {
    "tiny": {
        "ip": {"limit": 1, "window": 60, "block": 30},
        "identity": {"limit": 1, "window": 60, "block": 30},
    },
    "invalid": {
        "ip": {"limit": "bad", "window": None, "block": 0},
    },
    "password_login": {
        "ip": {"limit": 100, "window": 60, "block": 30},
        "identity": {"limit": 100, "window": 60, "block": 30},
    },
    "admin_login": {
        "ip": {"limit": 1, "window": 60, "block": 30},
        "identity": {"limit": 100, "window": 60, "block": 30},
    },
}
SMALL_FAILURE_LIMITS = {
    "password_login": {
        "identity": {"limit": 2, "window": 60, "block": 30},
        "pair": {"limit": 2, "window": 60, "block": 30},
    }
}


@override_settings(
    AUTH_RATE_LIMITS=SMALL_REQUEST_LIMITS,
    AUTH_FAILURE_LIMITS=SMALL_FAILURE_LIMITS,
)
class AuthAbuseControlTests(TestCase):
    def setUp(self):
        self.member = create_member("limits@example.com")
        self.factory = RequestFactory()

    def request(self, **meta):
        defaults = {"REMOTE_ADDR": "198.51.100.10"}
        defaults.update(meta)
        return self.factory.post("/authn/login/", **defaults)

    def test_ip_normalization_rate_windows_and_throttle_helpers(self):
        self.assertEqual(normalize_security_identity(" User@Example.COM "), "user@example.com")
        request = self.request()
        self.assertEqual(client_ip(request), "198.51.100.10")
        with override_settings(AUTH_TRUSTED_PROXY_COUNT=1):
            proxied = self.request(HTTP_X_FORWARDED_FOR="192.0.2.1, 203.0.113.8")
            self.assertEqual(client_ip(proxied), "203.0.113.8")
        with override_settings(AUTH_TRUSTED_PROXY_COUNT=2):
            cloudfront = self.request(HTTP_X_FORWARDED_FOR="192.0.2.1, 203.0.113.8")
            normalized_cloudfront = self.request(HTTP_X_FORWARDED_FOR="192.0.2.1")
            self.assertEqual(client_ip(cloudfront), "192.0.2.1")
            self.assertEqual(client_ip(normalized_cloudfront), "198.51.100.10")
        with override_settings(
            AUTH_TRUSTED_PROXY_COUNT=1,
            AUTH_TRUSTED_PROXY_CIDRS=["203.0.113.0/24"],
            AUTH_TRUSTED_PROXY_CIDR_HOPS=1,
        ):
            direct_with_forged_prefix = self.request(
                HTTP_X_FORWARDED_FOR="192.0.2.1, 198.51.100.10"
            )
            cloudfront_with_forged_prefix = self.request(
                HTTP_X_FORWARDED_FOR="192.0.2.1, 198.51.100.10, 203.0.113.8"
            )
            malformed_rightmost = self.request(HTTP_X_FORWARDED_FOR="192.0.2.1, not-an-ip")
            trusted_proxy_without_client = self.request(HTTP_X_FORWARDED_FOR="203.0.113.8")
            self.assertEqual(client_ip(direct_with_forged_prefix), "198.51.100.10")
            self.assertEqual(client_ip(cloudfront_with_forged_prefix), "198.51.100.10")
            self.assertEqual(client_ip(malformed_rightmost), "unknown")
            self.assertEqual(client_ip(trusted_proxy_without_client), "unknown")
        with override_settings(
            AUTH_TRUSTED_PROXY_COUNT=1,
            AUTH_TRUSTED_PROXY_CIDRS="invalid-network,203.0.113.0/24",
            AUTH_TRUSTED_PROXY_CIDR_HOPS=1,
        ):
            string_configured_cidrs = self.request(
                HTTP_X_FORWARDED_FOR="198.51.100.10, 203.0.113.8"
            )
            self.assertEqual(client_ip(string_configured_cidrs), "198.51.100.10")
        self.assertEqual(client_ip(self.request(REMOTE_ADDR="not-an-ip")), "unknown")

        self.assertTrue(consume_request_rate_limit("missing", request).allowed)
        first = consume_request_rate_limit("tiny", request)
        self.assertTrue(first.allowed)
        second = consume_request_rate_limit("tiny", request)
        self.assertFalse(second.allowed)
        third = consume_request_rate_limit("tiny", request)
        self.assertFalse(third.allowed)
        self.assertGreaterEqual(third.retry_after, 1)

        bucket = AuthRateLimitBucket.objects.get(scope="tiny:ip")
        bucket.window_started_at = timezone.now() - timedelta(minutes=2)
        bucket.blocked_until = None
        bucket.save(update_fields=["window_started_at", "blocked_until"])
        self.assertTrue(consume_request_rate_limit("tiny", request).allowed)

        other_ip = self.request(REMOTE_ADDR="198.51.100.11")
        self.assertTrue(consume_request_rate_limit("tiny", other_ip, "same@example.com").allowed)
        identity_blocked = consume_request_rate_limit("tiny", other_ip, "same@example.com")
        self.assertFalse(identity_blocked.allowed)

        invalid_first = consume_request_rate_limit("invalid", other_ip)
        invalid_second = consume_request_rate_limit("invalid", other_ip)
        self.assertTrue(invalid_first.allowed)
        self.assertFalse(invalid_second.allowed)

        throttle = AuthRateThrottle()
        api_request = APIRequestFactory().post("/authn/login/", {}, format="json")
        self.assertTrue(throttle.allow_request(api_request, SimpleNamespace()))
        self.assertIsNone(throttle.wait())
        read_request = APIRequestFactory().get("/authn/account-emails/")
        self.assertTrue(
            throttle.allow_request(
                read_request,
                SimpleNamespace(auth_rate_scope="tiny", auth_rate_methods={"POST"}),
            )
        )

    def test_failure_buckets_block_and_success_clears(self):
        request = self.request()
        self.assertTrue(password_login_allowed("limits@example.com", request).allowed)
        record_password_login_failure("limits@example.com", request)
        self.assertTrue(password_login_allowed("limits@example.com", request).allowed)
        record_password_login_failure("limits@example.com", request)
        blocked = password_login_allowed("limits@example.com", request)
        self.assertFalse(blocked.allowed)
        self.assertGreaterEqual(blocked.retry_after, 1)

        with self.assertRaisesMessage(Exception, "Invalid email or password"):
            login_with_password(
                "limits@example.com",
                "password123",
                request=request,
            )

        clear_password_login_failures("limits@example.com", request)
        self.assertTrue(password_login_allowed("limits@example.com", request).allowed)
        self.assertEqual(
            login_with_password(
                "limits@example.com",
                "password123",
                request=request,
            ),
            self.member,
        )

        with override_settings(
            AUTH_FAILURE_LIMITS={
                "password_login": {
                    "identity": {"limit": 1, "window": 60, "block": 30},
                }
            }
        ):
            record_password_login_failure("identity-only@example.com", request)
            self.assertFalse(password_login_allowed("identity-only@example.com", request).allowed)

    def test_public_and_admin_endpoints_return_429_with_retry_after(self):
        client = APIClient()
        first = client.post(
            "/authn/login/",
            {"email": "limits@example.com", "password": "password123"},
            format="json",
            REMOTE_ADDR="203.0.113.20",
        )
        self.assertEqual(first.status_code, 200)
        second = client.post(
            "/authn/login/",
            {"email": "limits@example.com", "password": "password123"},
            format="json",
            REMOTE_ADDR="203.0.113.20",
        )
        self.assertEqual(second.status_code, 200)

        first_admin = client.post(
            "/admin/login/",
            {"email": "missing@example.com", "password": "wrong"},
            REMOTE_ADDR="203.0.113.30",
        )
        self.assertEqual(first_admin.status_code, 400)
        blocked_admin = client.post(
            "/admin/login/",
            {"email": "missing@example.com", "password": "wrong"},
            REMOTE_ADDR="203.0.113.30",
        )
        self.assertEqual(blocked_admin.status_code, 429)
        self.assertEqual(blocked_admin["Retry-After"], "30")

        with override_settings(
            AUTH_RATE_LIMITS={
                "password_login": {
                    "ip": {"limit": 1, "window": 60, "block": 30},
                }
            },
            AUTH_FAILURE_LIMITS={},
        ):
            AuthRateLimitBucket.objects.all().delete()
            first_login = client.post(
                "/authn/login/",
                {"email": "limits@example.com", "password": "password123"},
                format="json",
                REMOTE_ADDR="203.0.113.40",
            )
            self.assertEqual(first_login.status_code, 200)
            blocked_login = client.post(
                "/authn/login/",
                {"email": "limits@example.com", "password": "password123"},
                format="json",
                REMOTE_ADDR="203.0.113.40",
            )
            self.assertEqual(blocked_login.status_code, 429)
            self.assertIn("30", blocked_login["Retry-After"])

    def test_cookie_origin_helper_accepts_configured_and_rejects_foreign_origins(self):
        enforce_cookie_request_origin(self.request())
        allowed = self.request(HTTP_ORIGIN="http://testserver")
        enforce_cookie_request_origin(allowed)
        with override_settings(FRONTEND_URL="https://app.example"):
            configured = self.request(HTTP_ORIGIN="https://app.example")
            enforce_cookie_request_origin(configured)
        with self.assertRaises(PermissionDenied):
            enforce_cookie_request_origin(self.request(HTTP_ORIGIN="https://foreign.example"))
