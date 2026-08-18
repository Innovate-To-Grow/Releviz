"""Regression tests for database-backed authentication abuse controls."""

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.test import RequestFactory, TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import AuthRateLimitBucket
from apps.authn.security import (
    AuthRateThrottle,
    RateLimitDecision,
    clear_password_login_failures,
    consume_request_rate_limit,
    password_login_allowed,
    record_password_login_failure,
)
from apps.authn.security.throttles import DurableAuthThrottle, LoginRateThrottle
from apps.authn.tests.helpers import create_test_member

SMALL_REQUEST_LIMITS = {
    "tiny": {
        "ip": {"limit": 1, "window": 60, "block": 30},
        "identity": {"limit": 1, "window": 60, "block": 30},
    },
    "invalid": {
        "ip": {"limit": "bad", "window": None, "block": 0},
    },
    "password_login": {
        "ip": {"limit": 1, "window": 60, "block": 30},
        "identity": {"limit": 1, "window": 60, "block": 30},
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
class DurableRateLimitTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()

    def request(self, address="198.51.100.10"):
        return self.factory.post("/authn/login/", REMOTE_ADDR=address)

    def test_fixed_window_state_is_shared_and_resets_after_window(self):
        request = self.request()
        self.assertTrue(consume_request_rate_limit("missing", request).allowed)
        self.assertTrue(consume_request_rate_limit("tiny", request).allowed)

        blocked = consume_request_rate_limit("tiny", request)
        self.assertFalse(blocked.allowed)
        self.assertEqual(blocked.retry_after, 30)
        self.assertFalse(consume_request_rate_limit("tiny", request).allowed)

        bucket = AuthRateLimitBucket.objects.get(scope="tiny:ip")
        self.assertIn("tiny:", str(bucket))
        bucket.window_started_at = timezone.now() - timedelta(minutes=2)
        bucket.blocked_until = None
        bucket.save(update_fields=["window_started_at", "blocked_until"])
        self.assertTrue(consume_request_rate_limit("tiny", request).allowed)

    def test_identity_cost_and_invalid_configuration_are_bounded(self):
        first = self.request("198.51.100.11")
        second = self.request("198.51.100.12")
        self.assertTrue(consume_request_rate_limit("tiny", first, "User@Example.com").allowed)
        identity_blocked = consume_request_rate_limit("tiny", second, " user@example.COM ")
        self.assertFalse(identity_blocked.allowed)

        invalid = self.request("198.51.100.13")
        self.assertTrue(consume_request_rate_limit("invalid", invalid, cost=0).allowed)
        self.assertFalse(consume_request_rate_limit("invalid", invalid, cost=2).allowed)

    def test_failure_limits_block_and_clear_independently(self):
        request = self.request()
        email = "limits@example.com"
        self.assertTrue(password_login_allowed(email, request).allowed)
        record_password_login_failure(email, request)
        self.assertTrue(password_login_allowed(email, request).allowed)
        record_password_login_failure(email, request)

        blocked = password_login_allowed(email, request)
        self.assertFalse(blocked.allowed)
        self.assertGreaterEqual(blocked.retry_after, 1)
        clear_password_login_failures(email, request)
        self.assertTrue(password_login_allowed(email, request).allowed)

        with override_settings(AUTH_FAILURE_LIMITS={}):
            record_password_login_failure("unconfigured@example.com", request)
            self.assertTrue(password_login_allowed("unconfigured@example.com", request).allowed)

    def test_generic_and_named_throttles_use_durable_buckets(self):
        request = SimpleNamespace(
            META={"REMOTE_ADDR": "198.51.100.20"},
            data={"email": "limits@example.com"},
            method="POST",
        )
        view = SimpleNamespace(auth_rate_scope="tiny")
        first = AuthRateThrottle()
        second = AuthRateThrottle()
        self.assertTrue(first.allow_request(request, view))
        self.assertFalse(second.allow_request(request, view))
        self.assertEqual(second.wait(), 30)

        self.assertTrue(
            AuthRateThrottle().allow_request(
                request,
                SimpleNamespace(auth_rate_scope="tiny", auth_rate_methods={"GET"}),
            )
        )
        self.assertTrue(AuthRateThrottle().allow_request(request, SimpleNamespace()))

        custom_identity = SimpleNamespace(
            auth_rate_scope="tiny",
            get_auth_rate_identity=lambda _request: "another@example.com",
        )
        other_ip = SimpleNamespace(
            META={"REMOTE_ADDR": "198.51.100.21"},
            data={},
            method="POST",
        )
        self.assertTrue(AuthRateThrottle().allow_request(other_ip, custom_identity))

        login_request = SimpleNamespace(
            META={"REMOTE_ADDR": "198.51.100.22"},
            data={"identifier": "person@example.com"},
            method="POST",
            user=SimpleNamespace(is_authenticated=False),
        )
        self.assertTrue(LoginRateThrottle().allow_request(login_request, SimpleNamespace()))
        self.assertTrue(DurableAuthThrottle().allow_request(login_request, SimpleNamespace()))

    def test_password_login_endpoint_returns_retry_after_from_shared_limit(self):
        create_test_member("limits@example.com")
        client = APIClient()
        first = client.post(
            "/authn/login/",
            {"email": "limits@example.com", "password": "testpass123"},
            format="json",
            REMOTE_ADDR="203.0.113.40",
        )
        self.assertEqual(first.status_code, 200)
        second = client.post(
            "/authn/login/",
            {"email": "limits@example.com", "password": "testpass123"},
            format="json",
            REMOTE_ADDR="203.0.113.40",
        )
        self.assertEqual(second.status_code, 429)
        self.assertEqual(second["Retry-After"], "30")

    def test_password_failure_bucket_blocks_before_credential_validation(self):
        client = APIClient()
        with patch(
            "apps.authn.views.auth.login.password_login_allowed",
            return_value=RateLimitDecision(allowed=False, retry_after=17),
        ):
            response = client.post(
                "/authn/login/",
                {"email": "blocked@example.com", "password": "irrelevant"},
                format="json",
                REMOTE_ADDR="203.0.113.41",
            )

        self.assertEqual(response.status_code, 429)
        self.assertEqual(response["Retry-After"], "17")
