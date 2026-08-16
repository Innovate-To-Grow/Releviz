"""Coverage for the auth application configuration."""

from django.test import SimpleTestCase


class AppConfigReadyTests(SimpleTestCase):
    def test_ready_is_a_noop(self):
        from apps.authn.apps import AuthnConfig

        config = AuthnConfig.create("apps.authn")
        self.assertIsNone(config.ready())
