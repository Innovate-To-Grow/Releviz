"""Coverage gaps for misc: AppConfig.ready()."""

from unittest.mock import patch

from django.test import SimpleTestCase


class AppConfigReadyTests(SimpleTestCase):
    def test_ready_swallows_import_error(self):
        """apps.py:11-14 — ready() catches ImportError from the signals import."""
        import builtins

        from apps.authn.apps import AuthnConfig

        config = AuthnConfig.create("apps.authn")
        real_import = builtins.__import__
        attempted = {"signals": False}

        def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
            if level == 1 and fromlist and "signals" in fromlist:
                attempted["signals"] = True
                raise ImportError("boom")
            return real_import(name, globals, locals, fromlist, level)

        with patch.object(builtins, "__import__", side_effect=fake_import):
            config.ready()  # must not raise

        self.assertTrue(attempted["signals"], "ready() should have attempted the signals import")
