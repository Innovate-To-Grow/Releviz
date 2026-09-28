import tempfile
from pathlib import Path
from unittest.mock import patch

from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase, override_settings
from django.urls import resolve

from apps.core.middleware.e2e_coverage import E2EEndpointCoverageMiddleware


@override_settings(ENABLE_LEGACY_API_PREFIX=False)
class E2EEndpointCoverageMiddlewareTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.log = Path(self.directory.name) / "endpoints.log"

    def middleware(self, status=200, log_path=None):
        path = str(self.log) if log_path is None else log_path
        with patch.dict("os.environ", {"E2E_ENDPOINT_LOG": path}):
            return E2EEndpointCoverageMiddleware(lambda request: HttpResponse(status=status))

    def resolved(self, method, path):
        request = getattr(self.factory, method)(path)
        request.resolver_match = resolve(path)
        return request

    def test_records_the_matched_route_method_and_status(self):
        middleware = self.middleware(status=404)

        response = middleware(self.resolved("get", "/events/roster/abc-123/schedule"))
        middleware(self.resolved("post", "/authn/login/"))

        self.assertEqual(response.status_code, 404)
        self.assertEqual(
            self.log.read_text(encoding="utf-8").splitlines(),
            [
                "GET\tevents/roster/<str:participant_id>/schedule\t404",
                "POST\tauthn/login/\t404",
            ],
        )

    def test_skips_requests_that_resolved_to_no_route(self):
        middleware = self.middleware()

        middleware(self.factory.get("/nowhere/"))

        self.assertFalse(self.log.exists())

    def test_does_nothing_without_a_log_path(self):
        middleware = self.middleware(log_path="")

        response = middleware(self.resolved("get", "/health"))

        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.log.exists())
