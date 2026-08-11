"""Tests for ProfileView PATCH (text field updates)."""

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail

Member = get_user_model()

_PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"0" * 40


class ProfileUpdateTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(
            password="StrongPass123!",
            first_name="Original",
            last_name="Name",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.member, email_address="prof@example.com", email_type="primary", verified=True
        )
        self.client.force_authenticate(user=self.member)

    def test_get_profile_returns_all_fields(self):
        response = self.client.get("/authn/profile/")
        self.assertEqual(response.status_code, 200)
        data = response.data
        self.assertIn("member_uuid", data)
        self.assertIn("email", data)
        self.assertIn("first_name", data)
        self.assertIn("last_name", data)
        self.assertIn("middle_name", data)
        self.assertIn("organization", data)
        self.assertIn("email_subscribe", data)
        self.assertIn("is_active", data)
        self.assertIn("date_joined", data)
        self.assertIn("profile_image", data)
        self.assertNotIn("username", data)

    def test_patch_first_name(self):
        response = self.client.patch(
            "/authn/profile/",
            {"first_name": "NewFirst"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.member.refresh_from_db()
        self.assertEqual(self.member.first_name, "NewFirst")

    def test_patch_last_name(self):
        response = self.client.patch(
            "/authn/profile/",
            {"last_name": "NewLast"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.member.refresh_from_db()
        self.assertEqual(self.member.last_name, "NewLast")

    def test_patch_organization(self):
        response = self.client.patch(
            "/authn/profile/",
            {"organization": "Acme Corp"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.member.refresh_from_db()
        self.assertEqual(self.member.organization, "Acme Corp")

    def test_patch_email_subscribe(self):
        # Start subscribed
        primary = ContactEmail.objects.get(member=self.member, email_type="primary")
        primary.subscribe = True
        primary.save(update_fields=["subscribe"])

        response = self.client.patch(
            "/authn/profile/",
            {"email_subscribe": False},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        primary.refresh_from_db()
        self.assertFalse(primary.subscribe)

    def test_patch_multiple_fields(self):
        response = self.client.patch(
            "/authn/profile/",
            {"first_name": "Multi", "last_name": "Update", "organization": "TestOrg"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.member.refresh_from_db()
        self.assertEqual(self.member.first_name, "Multi")
        self.assertEqual(self.member.last_name, "Update")
        self.assertEqual(self.member.organization, "TestOrg")

    def test_patch_ignores_readonly_fields(self):
        original_uuid = str(self.member.member_uuid)

        response = self.client.patch(
            "/authn/profile/",
            {"email": "hacked@evil.com", "member_uuid": "00000000-0000-0000-0000-000000000000"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.member.refresh_from_db()
        self.assertEqual(str(self.member.member_uuid), original_uuid)

    def test_patch_email_subscribe_with_data_uri_profile_image_representation(self):
        # Store a data: URI directly so to_representation passes it through (lines 64-69).
        self.member.profile_image = "data:image/png;base64,QQ=="
        self.member.save(update_fields=["profile_image"])
        response = self.client.get("/authn/profile/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["profile_image"], "data:image/png;base64,QQ==")

    def test_get_profile_wraps_bare_base64_with_data_uri(self):
        self.member.profile_image = "QQ=="
        self.member.save(update_fields=["profile_image"])
        response = self.client.get("/authn/profile/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["profile_image"], "data:image/png;base64,QQ==")

    def test_get_profile_serialization_failure_returns_500(self):
        with patch(
            "apps.authn.views.account.profile.ProfileSerializer",
            side_effect=ValueError("boom"),
        ):
            response = self.client.get("/authn/profile/")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.data["detail"], "Failed to load profile.")

    def test_patch_profile_image_upload_success(self):
        upload = SimpleUploadedFile("avatar.png", _PNG_BYTES, content_type="image/png")
        response = self.client.patch("/authn/profile/", {"profile_image": upload}, format="multipart")
        self.assertEqual(response.status_code, 200)
        self.member.refresh_from_db()
        self.assertTrue(self.member.profile_image.startswith("data:image/png;base64,"))

    def test_patch_profile_image_too_large(self):
        big = SimpleUploadedFile("big.png", b"\x89PNG\r\n\x1a\n" + b"0" * (6 * 1024 * 1024), content_type="image/png")
        response = self.client.patch("/authn/profile/", {"profile_image": big}, format="multipart")
        self.assertEqual(response.status_code, 400)
        self.assertIn("5 MB", response.data["detail"])

    def test_patch_profile_image_disallowed_content_type(self):
        upload = SimpleUploadedFile("doc.pdf", _PNG_BYTES, content_type="application/pdf")
        response = self.client.patch("/authn/profile/", {"profile_image": upload}, format="multipart")
        self.assertEqual(response.status_code, 400)
        self.assertIn("JPEG, PNG, GIF, or WebP", response.data["detail"])

    def test_patch_profile_image_bad_magic_bytes(self):
        upload = SimpleUploadedFile("fake.png", b"not-an-image-at-all", content_type="image/png")
        response = self.client.patch("/authn/profile/", {"profile_image": upload}, format="multipart")
        self.assertEqual(response.status_code, 400)
        self.assertIn("does not match", response.data["detail"])

    def test_patch_invalid_json_field_returns_400(self):
        response = self.client.patch("/authn/profile/", {"first_name": ""}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_unauthenticated_returns_401(self):
        self.client.force_authenticate(user=None)
        response = self.client.get("/authn/profile/")
        self.assertEqual(response.status_code, 401)
