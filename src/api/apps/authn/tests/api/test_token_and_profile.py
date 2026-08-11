"""Tests for token refresh, image magic-byte validation, and profile GET."""

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

# noinspection PyProtectedMember
from apps.authn.models import ContactEmail
from apps.authn.views.account.profile import _validate_image_bytes

Member = get_user_model()


class PublicTokenRefreshTests(APITestCase):
    """Tests for the PublicTokenRefreshView (S1 fix)."""

    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(
            password="StrongPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.member, email_address="refresher@example.com", email_type="primary", verified=True
        )

    def test_refresh_returns_new_access_token(self):
        refresh = RefreshToken.for_user(self.member)
        response = self.client.post(
            "/authn/refresh/",
            {"refresh": str(refresh)},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("access", response.data)

    def test_refresh_rejects_invalid_token(self):
        response = self.client.post(
            "/authn/refresh/",
            {"refresh": "garbage-token"},
            format="json",
        )
        self.assertEqual(response.status_code, 401)

    def test_refresh_works_without_authentication_header(self):
        refresh = RefreshToken.for_user(self.member)
        # Explicitly ensure no auth header is set
        self.client.credentials()
        response = self.client.post(
            "/authn/refresh/",
            {"refresh": str(refresh)},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("access", response.data)


class ImageMagicByteValidationTests(SimpleTestCase):
    """Tests for _validate_image_bytes helper (S6 fix)."""

    def test_png_magic_bytes_accepted(self):
        self.assertTrue(_validate_image_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 24))

    def test_jpeg_magic_bytes_accepted(self):
        self.assertTrue(_validate_image_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 28))

    def test_gif_magic_bytes_accepted(self):
        self.assertTrue(_validate_image_bytes(b"GIF89a" + b"\x00" * 26))

    def test_webp_magic_bytes_accepted(self):
        self.assertTrue(_validate_image_bytes(b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 20))

    def test_pdf_magic_bytes_rejected(self):
        self.assertFalse(_validate_image_bytes(b"%PDF-1.5" + b"\x00" * 24))

    def test_empty_bytes_rejected(self):
        self.assertFalse(_validate_image_bytes(b""))


class ProfileImageUploadTests(APITestCase):
    """Tests for profile image upload validation (S6 + B6 fixes)."""

    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(
            password="StrongPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.member, email_address="uploader@example.com", email_type="primary", verified=True
        )
        self.client.force_authenticate(user=self.member)

    def test_upload_rejects_file_with_wrong_magic_bytes(self):
        pdf_content = b"%PDF-1.5" + b"\x00" * 100
        f = SimpleUploadedFile("image.png", pdf_content, content_type="image/png")
        response = self.client.patch(
            "/authn/profile/",
            {"profile_image": f},
            format="multipart",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("does not match", response.data["detail"])

    def test_get_profile_returns_null_image_by_default(self):
        response = self.client.get("/authn/profile/")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.data["profile_image"])
