"""Password login resolves an email address or a normalized phone number."""

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail

Member = get_user_model()

LOGIN_URL = "/authn/login/"
PASSWORD = "LoginPass123!"


class PasswordLoginIdentifierTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.email_member = Member.objects.create_user(
            password=PASSWORD, is_active=True, first_name="Eve", last_name="Email"
        )
        ContactEmail.objects.create(
            member=self.email_member, email_address="eve@example.com", email_type="primary", verified=True
        )

    def _login(self, identifier, password=PASSWORD, field="email"):
        cache.clear()  # keep each attempt clear of the login throttle
        return self.client.post(LOGIN_URL, {field: identifier, "password": password}, format="json")

    def test_email_and_password_login_still_works(self):
        self.assertEqual(self._login("eve@example.com").status_code, 200)

    def test_wrong_password_and_unknown_identifier_are_indistinguishable(self):
        wrong = self._login("eve@example.com", password="TotallyWrong999!")
        unknown = self._login("unknown@example.com")
        self.assertEqual(wrong.status_code, 400)
        self.assertEqual(unknown.status_code, 400)
        self.assertEqual(str(wrong.data), str(unknown.data))
