"""CORS behaviour the cross-origin web app depends on."""

from django.test import SimpleTestCase, override_settings

WEB_ORIGIN = "https://app.example.com"


@override_settings(CORS_ALLOWED_ORIGINS=[WEB_ORIGIN])
class CorsExposeHeadersTests(SimpleTestCase):
    def test_allowed_origin_can_read_the_calendar_file_name(self):
        # The web app names the downloaded calendar from Content-Disposition,
        # which the browser only reveals when the API exposes it.
        response = self.client.get("/events/finalization/calendar", HTTP_ORIGIN=WEB_ORIGIN)

        self.assertEqual(response["Access-Control-Allow-Origin"], WEB_ORIGIN)
        exposed = [
            header.strip().lower()
            for header in response["Access-Control-Expose-Headers"].split(",")
        ]
        self.assertIn("content-disposition", exposed)

    def test_unlisted_origin_gets_no_cors_headers(self):
        response = self.client.get(
            "/events/finalization/calendar",
            HTTP_ORIGIN="https://elsewhere.example",
        )

        self.assertNotIn("Access-Control-Allow-Origin", response)
        self.assertNotIn("Access-Control-Expose-Headers", response)
