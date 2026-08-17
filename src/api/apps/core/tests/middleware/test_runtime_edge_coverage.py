import json
import logging
from types import SimpleNamespace
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.http import HttpResponse, StreamingHttpResponse
from django.test import RequestFactory, SimpleTestCase, override_settings

from apps.core.middleware.alb_health import (
    ALB_HEALTH_CHECK_USER_AGENT,
    AlbHealthCheckHostMiddleware,
)
from apps.core.middleware.csp_middleware import ContentSecurityPolicyMiddleware
from apps.core.middleware.csp_report import _csp_report_rate_limited, csp_report
from apps.core.utils.error_tracking import initialize_error_tracking, scrub_error_event
from apps.core.utils.logging import RequestContextFilter, _json_value, request_id_context


class AlbHealthCheckHostMiddlewareEdgeTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    @override_settings(
        ALLOWED_HOSTS=["api.example.com", "*"],
        ENABLE_LEGACY_API_PREFIX=False,
    )
    def test_alb_probe_is_normalized_to_canonical_https_host(self):
        request = self.factory.get(
            "/health/ready",
            HTTP_HOST="10.0.0.1",
            HTTP_USER_AGENT=ALB_HEALTH_CHECK_USER_AGENT,
        )
        middleware = AlbHealthCheckHostMiddleware(lambda received: received)

        self.assertIs(middleware(request), request)
        self.assertEqual(request.META["HTTP_HOST"], "api.example.com")
        self.assertEqual(request.META["HTTP_X_FORWARDED_PROTO"], "https")

    @override_settings(
        ALLOWED_HOSTS=["*", ".example.com", ""],
        ENABLE_LEGACY_API_PREFIX=False,
    )
    def test_probe_is_left_unchanged_without_a_canonical_allowed_host(self):
        request = self.factory.get(
            "/health",
            HTTP_HOST="10.0.0.1",
            HTTP_USER_AGENT=ALB_HEALTH_CHECK_USER_AGENT,
        )

        AlbHealthCheckHostMiddleware(lambda received: received)(request)

        self.assertEqual(request.META["HTTP_HOST"], "10.0.0.1")
        self.assertNotIn("HTTP_X_FORWARDED_PROTO", request.META)

    @override_settings(ALLOWED_HOSTS=["api.example.com"], ENABLE_LEGACY_API_PREFIX=True)
    def test_legacy_health_prefix_is_supported_only_when_enabled(self):
        request = self.factory.get(
            "/api/health/live",
            HTTP_USER_AGENT=ALB_HEALTH_CHECK_USER_AGENT,
        )

        AlbHealthCheckHostMiddleware(lambda received: received)(request)

        self.assertEqual(request.META["HTTP_HOST"], "api.example.com")


class ContentSecurityPolicyMiddlewareEdgeTests(SimpleTestCase):
    def setUp(self):
        self.middleware = ContentSecurityPolicyMiddleware(lambda _request: HttpResponse())

    def test_invalid_port_is_not_treated_as_an_origin(self):
        self.assertIsNone(self.middleware._url_origin("https://example.com:not-a-port/path"))

    def test_streaming_and_encoded_responses_are_not_rewritten(self):
        streaming = StreamingHttpResponse(iter([b"<style></style>"]), content_type="text/html")
        self.middleware._nonce_vendor_styles(streaming, "nonce")
        self.assertTrue(streaming.streaming)

        encoded = HttpResponse("<style></style>", content_type="text/html")
        encoded["Content-Encoding"] = "gzip"
        original = encoded.content
        self.middleware._nonce_vendor_styles(encoded, "nonce")
        self.assertEqual(encoded.content, original)

    @patch("apps.core.middleware.csp_middleware.logger.exception")
    def test_unknown_response_charset_is_safely_ignored(self, log_exception):
        response = SimpleNamespace(
            streaming=False,
            charset="not-a-real-codec",
            content=b"<style></style>",
            get=lambda name, default="": "text/html" if name == "Content-Type" else default,
        )

        self.middleware._nonce_vendor_styles(response, "nonce")

        log_exception.assert_called_once_with("Unable to nonce CSP inline elements")


@override_settings(
    CSP_REPORT_RATE_LIMIT=2,
    CSP_REPORT_RATE_WINDOW_SECONDS=60,
)
class ContentSecurityPolicyReportEdgeTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    @override_settings(NUM_PROXIES=1)
    @patch("apps.core.middleware.csp_report.cache.incr", return_value=2)
    @patch("apps.core.middleware.csp_report.cache.add", return_value=False)
    def test_forwarded_client_identity_uses_last_proxy_value(self, cache_add, _cache_incr):
        request = self.factory.post("/csp-report/", HTTP_X_FORWARDED_FOR="client, proxy")

        self.assertFalse(_csp_report_rate_limited(request))
        self.assertIn("csp-report-rate:", cache_add.call_args.args[0])

    @override_settings(NUM_PROXIES=1)
    @patch("apps.core.middleware.csp_report.cache.add", return_value=True)
    def test_empty_forwarded_parts_fall_back_to_remote_address(self, cache_add):
        request = self.factory.post(
            "/csp-report/",
            HTTP_X_FORWARDED_FOR=" , ",
            REMOTE_ADDR="192.0.2.1",
        )

        self.assertFalse(_csp_report_rate_limited(request))
        cache_add.assert_called_once()

    @patch(
        "apps.core.middleware.csp_report.cache.add",
        side_effect=RuntimeError("cache unavailable"),
    )
    @patch("apps.core.middleware.csp_report.logger.exception")
    def test_cache_failure_does_not_block_reports(self, log_exception, _cache_add):
        request = self.factory.post("/csp-report/", REMOTE_ADDR="192.0.2.1")

        self.assertFalse(_csp_report_rate_limited(request))
        log_exception.assert_called_once_with("Unable to apply CSP report rate limit")

    @patch("apps.core.middleware.csp_report._csp_report_rate_limited", return_value=False)
    def test_invalid_content_length_falls_back_to_bounded_body_read(self, _limited):
        request = self.factory.post(
            "/csp-report/",
            data=json.dumps({"csp-report": {"violated-directive": "script-src"}}),
            content_type="application/json",
        )
        request.META["CONTENT_LENGTH"] = "invalid"

        self.assertEqual(csp_report(request).status_code, 204)

    @patch("apps.core.middleware.csp_report._csp_report_rate_limited", return_value=False)
    @patch("apps.core.middleware.csp_report.logger.warning")
    def test_ipv6_and_malformed_urls_are_sanitized_without_failure(self, warning, _limited):
        request = self.factory.post(
            "/csp-report/",
            data=json.dumps(
                {
                    "csp-report": {
                        "violated-directive": "frame-src",
                        "document-uri": "https://[2001:db8::1]/invite/secret?token=hidden",
                        "source-file": "http://[",
                    }
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(csp_report(request).status_code, 204)
        logged_args = warning.call_args.args
        self.assertIn("https://[2001:db8::1]/invite/<redacted>", logged_args)
        self.assertIn("http://[", logged_args)


class ErrorTrackingEdgeTests(SimpleTestCase):
    def test_scrubber_removes_all_privacy_sensitive_sections(self):
        event = {
            "request": {},
            "user": {},
            "breadcrumbs": [],
            "extra": {},
            "tags": {},
            "exception": {"values": []},
        }

        scrubbed = scrub_error_event(event, {"hint": True})

        self.assertEqual(scrubbed, {"exception": {"values": []}})

    def test_initialization_is_disabled_without_dsn(self):
        self.assertFalse(
            initialize_error_tracking(
                dsn="", environment="test", release="", traces_sample_rate="0"
            )
        )

    def test_invalid_sample_rates_are_rejected(self):
        with self.assertRaisesMessage(ImproperlyConfigured, "must be a number"):
            initialize_error_tracking(
                dsn="https://dsn.example", environment="", release="", traces_sample_rate="bad"
            )
        with self.assertRaisesMessage(ImproperlyConfigured, "between 0 and 1"):
            initialize_error_tracking(
                dsn="https://dsn.example", environment="", release="", traces_sample_rate="2"
            )

    @patch("apps.core.utils.error_tracking.sentry_init")
    def test_valid_configuration_initializes_privacy_bounded_sentry(self, sentry_init):
        self.assertTrue(
            initialize_error_tracking(
                dsn="https://dsn.example",
                environment="production",
                release="release-1",
                traces_sample_rate="0.25",
            )
        )
        self.assertEqual(sentry_init.call_args.kwargs["traces_sample_rate"], 0.25)
        self.assertFalse(sentry_init.call_args.kwargs["send_default_pii"])


class StructuredLoggingEdgeTests(SimpleTestCase):
    def test_nonprimitive_values_are_stringified(self):
        self.assertEqual(_json_value(SimpleNamespace(name="value")), "namespace(name='value')")

    def test_request_filter_preserves_existing_request_id(self):
        token = request_id_context.set("context-id")
        try:
            record = logging.LogRecord("test", logging.INFO, __file__, 1, "event", (), None)
            record.request_id = "existing-id"
            self.assertTrue(RequestContextFilter().filter(record))
            self.assertEqual(record.request_id, "existing-id")
        finally:
            request_id_context.reset(token)
