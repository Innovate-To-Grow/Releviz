"""Password login resolves an email address or a normalized phone number."""

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail, ContactPhone

Member = get_user_model()

LOGIN_URL = "/authn/login/"
PASSWORD = "LoginPass123!"


class PasswordLoginIdentifierTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.phone_member = Member.objects.create_user(
            password=PASSWORD, is_active=True, first_name="Pat", last_name="Phone"
        )
        ContactPhone.objects.create(member=self.phone_member, phone_number="2095551234", region="1-US", verified=True)
        self.email_member = Member.objects.create_user(
            password=PASSWORD, is_active=True, first_name="Eve", last_name="Email"
        )
        ContactEmail.objects.create(
            member=self.email_member, email_address="eve@example.com", email_type="primary", verified=True
        )

    def _login(self, identifier, password=PASSWORD, field="email"):
        cache.clear()  # keep each attempt clear of the login throttle
        return self.client.post(LOGIN_URL, {field: identifier, "password": password}, format="json")

    def test_phone_number_and_password_login(self):
        response = self._login("2095551234")
        self.assertEqual(response.status_code, 200)
        self.assertIn("access", response.data)

    def test_phone_login_accepts_formatted_and_e164(self):
        for value in ["+1 209 555 1234", "12095551234", "(209) 555-1234"]:
            with self.subTest(value=value):
                self.assertEqual(self._login(value).status_code, 200)

    def test_email_and_password_login_still_works(self):
        self.assertEqual(self._login("eve@example.com").status_code, 200)

    def test_identifier_alias_field_works(self):
        response = self._login("2095551234", field="identifier")
        self.assertEqual(response.status_code, 200)

    def test_unverified_phone_cannot_login(self):
        member = Member.objects.create_user(password=PASSWORD, is_active=True, first_name="U", last_name="V")
        ContactPhone.objects.create(member=member, phone_number="2095550000", region="1-US", verified=False)
        response = self._login("2095550000")
        self.assertEqual(response.status_code, 400)
        self.assertIn("Invalid credentials", str(response.data))

    def test_wrong_password_and_unknown_identifier_are_indistinguishable(self):
        wrong = self._login("2095551234", password="TotallyWrong999!")
        unknown = self._login("2025550000")
        self.assertEqual(wrong.status_code, 400)
        self.assertEqual(unknown.status_code, 400)
        self.assertEqual(str(wrong.data), str(unknown.data))

    def test_inactive_member_cannot_login(self):
        self.phone_member.is_active = False
        self.phone_member.save(update_fields=["is_active"])
        response = self._login("2095551234")
        self.assertEqual(response.status_code, 400)
        self.assertIn("Invalid credentials", str(response.data))
