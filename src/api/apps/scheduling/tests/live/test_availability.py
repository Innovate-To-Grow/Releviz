from types import SimpleNamespace
from unittest.mock import patch

from django.test import AsyncRequestFactory, RequestFactory, SimpleTestCase, override_settings

from apps.scheduling.services.live import availability
from apps.scheduling.services.live.availability import live_stream_available


def postgres():
    return patch.object(availability, "connection", SimpleNamespace(vendor="postgresql"))


class LiveStreamAvailabilityTests(SimpleTestCase):
    def asgi_request(self):
        return AsyncRequestFactory().get("/events/stream", {"code": "ABCDEF"})

    @override_settings(LIVE_STREAM_ENABLED=False)
    def test_disabled_by_setting(self):
        with postgres():
            self.assertEqual(
                live_stream_available(self.asgi_request()),
                "Live updates are disabled",
            )

    def test_wsgi_request_is_refused(self):
        request = RequestFactory().get("/events/stream", {"code": "ABCDEF"})
        with postgres():
            self.assertEqual(live_stream_available(request), "Live updates need the ASGI server")

    def test_non_postgres_vendor_is_refused(self):
        with patch.object(availability, "connection", SimpleNamespace(vendor="sqlite")):
            self.assertEqual(
                live_stream_available(self.asgi_request()),
                "Live updates need PostgreSQL",
            )

    def test_asgi_and_postgres_are_available(self):
        with postgres():
            self.assertIsNone(live_stream_available(self.asgi_request()))
