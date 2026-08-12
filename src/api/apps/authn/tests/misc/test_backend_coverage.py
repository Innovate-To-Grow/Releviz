"""Coverage for authn backends: EmailAuthBackend."""

from django.contrib.auth import get_backends, get_user_model
from django.test import TestCase

from apps.authn.models import ContactEmail
from apps.authn.security.backends import EmailAuthBackend

Member = get_user_model()


def _member(**kw):
    return Member.objects.create_user(
        password="StrongPass123!",
        first_name=kw.pop("first_name", "A"),
        last_name=kw.pop("last_name", "B"),
        **kw,
    )


class EmailAuthBackendTests(TestCase):
    def test_configured_backend_is_importable(self):
        self.assertIsInstance(get_backends()[0], EmailAuthBackend)

    def test_username_falls_back_to_email_kwarg(self):
        member = _member(is_active=True)
        ContactEmail.objects.create(
            member=member, email_address="b@example.com", email_type="primary", verified=True
        )
        backend = EmailAuthBackend()
        result = backend.authenticate(None, email="b@example.com", password="StrongPass123!")
        self.assertEqual(result, member)

    def test_missing_password_returns_none(self):
        backend = EmailAuthBackend()
        self.assertIsNone(backend.authenticate(None, username="b@example.com", password=None))

    def test_unknown_email_returns_none(self):
        backend = EmailAuthBackend()
        self.assertIsNone(backend.authenticate(None, username="nobody@example.com", password="x"))
