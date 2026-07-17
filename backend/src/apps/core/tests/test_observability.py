import json
import logging
import uuid
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase, override_settings

from apps.core.error_tracking import initialize_error_tracking, scrub_error_event
from apps.core.logging import JsonFormatter, RequestContextFilter, request_id_context
from apps.core.middleware import (
    ALB_HEALTH_CHECK_USER_AGENT,
    AlbHealthCheckHostMiddleware,
    RequestObservabilityMiddleware,
    _request_id,
    _route,
)


class AlbHealthCheckHostMiddlewareTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    @patch("apps.core.middleware.settings.ALLOWED_HOSTS", ["releviz.com"])
    def test_normalizes_exact_alb_probe_without_widening_allowed_hosts(self):
        observed = {}

        def respond(request):
            observed["host"] = request.get_host()
            observed["proto"] = request.META.get("HTTP_X_FORWARDED_PROTO")
            return HttpResponse(status=200)

        request = self.factory.get(
            "/api/health",
            HTTP_HOST="10.0.11.42:4000",
            HTTP_USER_AGENT=ALB_HEALTH_CHECK_USER_AGENT,
        )
        response = AlbHealthCheckHostMiddleware(respond)(request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(observed, {"host": "releviz.com", "proto": "https"})

    @patch("apps.core.middleware.settings.ALLOWED_HOSTS", ["releviz.com"])
    def test_does_not_normalize_other_paths_or_user_agents(self):
        cases = [
            ("/api/events", ALB_HEALTH_CHECK_USER_AGENT),
            ("/api/health", "spoofed-health-checker"),
        ]
        for path, user_agent in cases:
            with self.subTest(path=path, user_agent=user_agent):
                request = self.factory.get(
                    path,
                    HTTP_HOST="untrusted.example",
                    HTTP_USER_AGENT=user_agent,
                )
                response = AlbHealthCheckHostMiddleware(lambda current: HttpResponse())(request)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(request.META["HTTP_HOST"], "untrusted.example")
                self.assertNotIn("HTTP_X_FORWARDED_PROTO", request.META)

    @override_settings(
        ALLOWED_HOSTS=["releviz.com"],
        SECURE_SSL_REDIRECT=True,
        SECURE_PROXY_SSL_HEADER=("HTTP_X_FORWARDED_PROTO", "https"),
    )
    def test_full_middleware_stack_accepts_alb_liveness_probe_only(self):
        accepted = self.client.get(
            "/api/health/live",
            HTTP_HOST="10.0.11.42:4000",
            HTTP_USER_AGENT=ALB_HEALTH_CHECK_USER_AGENT,
        )
        self.assertEqual(accepted.status_code, 200)

        rejected = self.client.get(
            "/api/health/live",
            HTTP_HOST="10.0.11.42:4000",
            HTTP_USER_AGENT="not-the-load-balancer",
        )
        self.assertEqual(rejected.status_code, 400)


class StructuredLoggingTests(SimpleTestCase):
    def test_formatter_emits_allowlisted_fields_and_safe_exception_stack(self):
        stream = StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(JsonFormatter())
        logger = logging.getLogger("observability-test")
        logger.handlers = [handler]
        logger.propagate = False
        logger.setLevel(logging.INFO)

        try:
            raise ValueError("private exception value")
        except ValueError:
            logger.exception(
                "safe_event",
                extra={
                    "event_id": uuid.UUID("11111111-1111-1111-1111-111111111111"),
                    "ip_address": "192.0.2.1",
                    "arbitrary_private_data": "secret",
                },
            )

        payload = json.loads(stream.getvalue())
        self.assertEqual(payload["event"], "safe_event")
        self.assertEqual(payload["level"], "ERROR")
        self.assertEqual(payload["logger"], "observability-test")
        self.assertEqual(payload["event_id"], "11111111-1111-1111-1111-111111111111")
        self.assertEqual(payload["exception_type"], "ValueError")
        self.assertEqual(payload["stack"][0]["file"], "test_observability.py")
        self.assertNotIn("ip_address", payload)
        self.assertNotIn("arbitrary_private_data", payload)
        self.assertNotIn("private exception value", stream.getvalue())

        django_record = logging.LogRecord(
            "django.request",
            logging.WARNING,
            "",
            1,
            "Not Found: %s",
            ("/event/PRIVATE-CAPABILITY",),
            None,
        )
        django_record.status_code = 404
        formatted_django_record = handler.formatter.format(django_record)
        self.assertEqual(json.loads(formatted_django_record)["event"], "django_request")
        self.assertNotIn("PRIVATE-CAPABILITY", formatted_django_record)

    def test_request_context_filter_preserves_explicit_or_current_identifier(self):
        filter_instance = RequestContextFilter()
        explicit = logging.LogRecord("test", logging.INFO, "", 1, "event", (), None)
        explicit.request_id = "explicit"
        self.assertTrue(filter_instance.filter(explicit))
        self.assertEqual(explicit.request_id, "explicit")

        contextual = logging.LogRecord("test", logging.INFO, "", 1, "event", (), None)
        token = request_id_context.set("contextual")
        try:
            self.assertTrue(filter_instance.filter(contextual))
        finally:
            request_id_context.reset(token)
        self.assertEqual(contextual.request_id, "contextual")


class RequestObservabilityMiddlewareTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    def test_request_identifier_accepts_uuid_and_replaces_invalid_values(self):
        supplied = "11111111-1111-4111-8111-111111111111"
        request = self.factory.get("/", HTTP_X_REQUEST_ID=supplied)
        self.assertEqual(_request_id(request), supplied)
        invalid = self.factory.get("/", HTTP_X_REQUEST_ID="not-a-uuid")
        self.assertNotEqual(_request_id(invalid), "not-a-uuid")
        self.assertIsInstance(uuid.UUID(_request_id(invalid)), uuid.UUID)

    def test_route_uses_resolver_template_and_never_raw_path(self):
        request = self.factory.get("/api/events/private-code?token=private")
        self.assertEqual(_route(request), "<unresolved>")
        request.resolver_match = SimpleNamespace(route="api/events/<str:code>")
        self.assertEqual(_route(request), "/api/events/<str:code>")
        request.resolver_match = SimpleNamespace(route="")
        self.assertEqual(_route(request), "/")

    def test_middleware_correlates_success_and_server_error_responses(self):
        supplied = "11111111-1111-4111-8111-111111111111"
        request = self.factory.get("/", HTTP_X_REQUEST_ID=supplied)
        request.resolver_match = SimpleNamespace(route="api/health/live")
        middleware = RequestObservabilityMiddleware(lambda current: HttpResponse(status=204))
        with self.assertLogs("releviz.requests", level="INFO") as logs:
            response = middleware(request)
        self.assertEqual(response["X-Request-ID"], supplied)
        self.assertIn("request_completed", logs.output[0])
        self.assertEqual(request_id_context.get(), "")

        failed_request = self.factory.get("/private")
        failed_request.resolver_match = None
        failed_middleware = RequestObservabilityMiddleware(lambda current: HttpResponse(status=503))
        with self.assertLogs("releviz.requests", level="ERROR") as failed_logs:
            failed_response = failed_middleware(failed_request)
        self.assertEqual(failed_response.status_code, 503)
        self.assertIn("request_completed", failed_logs.output[0])

    def test_middleware_resets_context_when_response_callable_raises(self):
        request = self.factory.get("/")

        def fail(current):
            raise RuntimeError("private")

        middleware = RequestObservabilityMiddleware(fail)
        with self.assertRaises(RuntimeError):
            middleware(request)
        self.assertEqual(request_id_context.get(), "")

    def test_process_exception_logs_type_without_returning_a_response(self):
        request = self.factory.get("/private")
        request.resolver_match = SimpleNamespace(route="api/example")
        middleware = RequestObservabilityMiddleware(lambda current: HttpResponse())
        error = RuntimeError("private")
        with self.assertLogs("releviz.requests", level="ERROR") as logs:
            result = middleware.process_exception(request, error)
        self.assertIsNone(result)
        self.assertIn("request_exception", logs.output[0])
        self.assertIn("RuntimeError", logs.output[0])


class ErrorTrackingTests(SimpleTestCase):
    def test_scrubber_removes_request_and_log_metadata(self):
        event = {
            "exception": {"values": []},
            "request": {"data": "private"},
            "user": {"email": "private@example.com"},
            "breadcrumbs": {"values": [{"message": "private"}]},
            "extra": {"schedule": "private"},
            "tags": {"event": "private"},
        }
        self.assertEqual(scrub_error_event(event, {"ignored": True}), {"exception": {"values": []}})

    @patch("apps.core.error_tracking.sentry_init")
    def test_initialization_is_opt_in_and_privacy_bounded(self, init_mock):
        self.assertFalse(
            initialize_error_tracking(
                dsn="",
                environment="",
                release="",
                traces_sample_rate="invalid-but-unused",
            )
        )
        init_mock.assert_not_called()

        self.assertTrue(
            initialize_error_tracking(
                dsn="https://public@example.invalid/1",
                environment="production",
                release="abc123",
                traces_sample_rate="0.25",
            )
        )
        options = init_mock.call_args.kwargs
        self.assertFalse(options["send_default_pii"])
        self.assertEqual(options["max_request_body_size"], "never")
        self.assertEqual(options["max_breadcrumbs"], 0)
        self.assertEqual(options["traces_sample_rate"], 0.25)
        self.assertIs(options["before_send"], scrub_error_event)

    def test_initialization_rejects_invalid_sample_rates(self):
        common = {
            "dsn": "https://public@example.invalid/1",
            "environment": "",
            "release": "",
        }
        with self.assertRaisesMessage(
            ImproperlyConfigured, "SENTRY_TRACES_SAMPLE_RATE must be a number."
        ):
            initialize_error_tracking(**common, traces_sample_rate="invalid")
        with self.assertRaisesMessage(
            ImproperlyConfigured, "SENTRY_TRACES_SAMPLE_RATE must be between 0 and 1."
        ):
            initialize_error_tracking(**common, traces_sample_rate="1.1")
