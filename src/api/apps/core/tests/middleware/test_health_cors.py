from django.test import TestCase, override_settings

FRONTEND_ORIGIN = "https://i2g.ucmerced.edu"


@override_settings(
    CORS_ALLOWED_ORIGINS=[FRONTEND_ORIGIN],
    CORS_ALLOW_CREDENTIALS=True,
)
class HealthCheckCORSTest(TestCase):
    def test_health_returns_cors_for_allowed_origin(self):
        response = self.client.get("/health/", HTTP_ORIGIN=FRONTEND_ORIGIN)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers.get("Access-Control-Allow-Origin"),
            FRONTEND_ORIGIN,
        )

    def test_readyz_returns_cors_for_allowed_origin(self):
        response = self.client.get("/readyz/", HTTP_ORIGIN=FRONTEND_ORIGIN)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers.get("Access-Control-Allow-Origin"),
            FRONTEND_ORIGIN,
        )

    def test_health_omits_cors_for_unlisted_origin(self):
        response = self.client.get("/health/", HTTP_ORIGIN="https://not-allowed.example.com")

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))

    def test_readyz_omits_cors_for_unlisted_origin(self):
        response = self.client.get("/readyz/", HTTP_ORIGIN="https://not-allowed.example.com")

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))

    @override_settings(ALLOWED_HOSTS=["testserver"])
    def test_health_bypasses_allowed_hosts_for_probe_hosts(self):
        response = self.client.get("/health/", HTTP_HOST="not-allowed.example.com")

        self.assertEqual(response.status_code, 200)

    @override_settings(ALLOWED_HOSTS=["testserver"])
    def test_readyz_bypasses_allowed_hosts_for_probe_hosts(self):
        response = self.client.get("/readyz/", HTTP_HOST="not-allowed.example.com")

        self.assertEqual(response.status_code, 200)
