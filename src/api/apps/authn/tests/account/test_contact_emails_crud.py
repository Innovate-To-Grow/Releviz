from unittest.mock import patch

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail

Member = get_user_model()


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class ContactEmailCrudTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        self.member = Member.objects.create_user(
            password="StrongPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.member,
            email_address="primary@example.com",
            email_type="primary",
            verified=True,
        )
        self.other_member = Member.objects.create_user(
            password="StrongPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.other_member,
            email_address="other@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_authenticate(user=self.member)

    # ── List ─────────────────────────────────────────────

    def test_list_contact_emails_excludes_primary(self, _mock_code, _mock_send):
        response = self.client.get("/authn/contact-emails/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 0)

    def test_create_sends_verification_code(self, _mock_code, mock_send):
        response = self.client.post(
            "/authn/contact-emails/",
            {
                "email_address": "secondary@example.com",
                "email_type": "secondary",
                "subscribe": True,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertFalse(response.data["verified"])
        self.assertEqual(response.data["email_address"], "secondary@example.com")
        self.assertEqual(response.data["email_type"], "secondary")
        self.assertTrue(response.data["subscribe"])
        mock_send.assert_called_once()

    def test_create_rejects_duplicate_member_email(self, _mock_code, _mock_send):
        response = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "primary@example.com"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_rejects_duplicate_contact_email(self, _mock_code, _mock_send):
        ContactEmail.objects.create(
            member=self.other_member,
            email_address="taken@example.com",
            email_type="other",
            verified=True,
        )
        response = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "taken@example.com"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_rejects_primary_type(self, _mock_code, _mock_send):
        response = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "new@example.com", "email_type": "primary"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_verify_code_marks_verified(self, _mock_code, _mock_send):
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "verify-me@example.com"},
            format="json",
        )
        contact_id = create_resp.data["id"]

        verify_resp = self.client.post(
            f"/authn/contact-emails/{contact_id}/verify-code/",
            {"code": "654321"},
            format="json",
        )
        self.assertEqual(verify_resp.status_code, 200)
        self.assertTrue(verify_resp.data["verified"])

        contact = ContactEmail.objects.get(pk=contact_id)
        self.assertTrue(contact.verified)

    def test_verify_code_rejects_wrong_code(self, _mock_code, _mock_send):
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "wrong-code@example.com"},
            format="json",
        )
        contact_id = create_resp.data["id"]

        verify_resp = self.client.post(
            f"/authn/contact-emails/{contact_id}/verify-code/",
            {"code": "000000"},
            format="json",
        )
        self.assertEqual(verify_resp.status_code, 400)

    def test_update_type_and_subscribe(self, _mock_code, _mock_send):
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "update-me@example.com", "email_type": "secondary"},
            format="json",
        )
        contact_id = create_resp.data["id"]

        patch_resp = self.client.patch(
            f"/authn/contact-emails/{contact_id}/",
            {"email_type": "other", "subscribe": True},
            format="json",
        )
        self.assertEqual(patch_resp.status_code, 200)
        self.assertEqual(patch_resp.data["email_type"], "other")
        self.assertTrue(patch_resp.data["subscribe"])

    def test_update_rejects_primary_type(self, _mock_code, _mock_send):
        contact = ContactEmail.objects.create(
            member=self.member,
            email_address="existing@example.com",
            email_type="secondary",
        )
        response = self.client.patch(
            f"/authn/contact-emails/{contact.pk}/",
            {"email_type": "primary"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_update_rejects_direct_primary_demotion(self, _mock_code, _mock_send):
        primary = ContactEmail.objects.get(member=self.member, email_type="primary")

        response = self.client.patch(
            f"/authn/contact-emails/{primary.pk}/",
            {"email_type": "other"},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        primary.refresh_from_db()
        self.assertEqual(primary.email_type, "primary")

    def test_update_ignores_email_address(self, _mock_code, _mock_send):
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "immutable@example.com"},
            format="json",
        )
        contact_id = create_resp.data["id"]

        patch_resp = self.client.patch(
            f"/authn/contact-emails/{contact_id}/",
            {"email_address": "changed@example.com", "subscribe": True},
            format="json",
        )
        self.assertEqual(patch_resp.status_code, 200)
        self.assertEqual(patch_resp.data["email_address"], "immutable@example.com")

    def test_delete_returns_204(self, _mock_code, _mock_send):
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "delete-me@example.com"},
            format="json",
        )
        contact_id = create_resp.data["id"]

        delete_resp = self.client.delete(f"/authn/contact-emails/{contact_id}/")
        self.assertEqual(delete_resp.status_code, 204)

        self.assertFalse(ContactEmail.objects.filter(pk=contact_id).exists())

    def test_make_primary_swaps_types(self, _mock_code, _mock_send):
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "new-primary@example.com"},
            format="json",
        )
        self.assertEqual(create_resp.status_code, 201)
        new_id = create_resp.data["id"]

        verify_resp = self.client.post(
            f"/authn/contact-emails/{new_id}/verify-code/",
            {"code": "654321"},
            format="json",
        )
        self.assertEqual(verify_resp.status_code, 200)

        make_resp = self.client.post(f"/authn/contact-emails/{new_id}/make-primary/")
        self.assertEqual(make_resp.status_code, 200)
        self.assertEqual(make_resp.data["email_type"], "primary")
        self.assertEqual(make_resp.data["email_address"], "new-primary@example.com")

        old_primary = ContactEmail.objects.get(email_address="primary@example.com")
        self.assertEqual(old_primary.email_type, "secondary")

        profile_resp = self.client.get("/authn/profile/")
        self.assertEqual(profile_resp.status_code, 200)
        self.assertEqual(profile_resp.data["email"], "new-primary@example.com")
        self.assertEqual(str(profile_resp.data["primary_email_id"]), str(new_id))

    def test_make_primary_rejects_unverified(self, _mock_code, _mock_send):
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "not-verified@example.com"},
            format="json",
        )
        contact_id = create_resp.data["id"]

        make_resp = self.client.post(f"/authn/contact-emails/{contact_id}/make-primary/")
        self.assertEqual(make_resp.status_code, 400)
        self.assertIn("detail", make_resp.data)

    def test_make_primary_idempotent_on_primary(self, _mock_code, _mock_send):
        primary = ContactEmail.objects.get(member=self.member, email_type="primary")
        make_resp = self.client.post(f"/authn/contact-emails/{primary.pk}/make-primary/")
        self.assertEqual(make_resp.status_code, 200)
        self.assertEqual(make_resp.data["email_type"], "primary")

    # ── One-secondary constraint ────────────────────────

    def test_create_rejects_second_secondary_email(self, _mock_code, _mock_send):
        first = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "sec1@example.com", "email_type": "secondary"},
            format="json",
        )
        self.assertEqual(first.status_code, 201)
        response = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "sec2@example.com", "email_type": "secondary"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_allows_other_when_secondary_exists(self, _mock_code, _mock_send):
        first = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "sec@example.com", "email_type": "secondary"},
            format="json",
        )
        self.assertEqual(first.status_code, 201)
        response = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "extra@example.com", "email_type": "other"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["email_type"], "other")

    def test_update_rejects_changing_to_secondary_when_one_exists(self, _mock_code, _mock_send):
        first = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "sec@example.com", "email_type": "secondary"},
            format="json",
        )
        self.assertEqual(first.status_code, 201)
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "other@example2.com", "email_type": "other"},
            format="json",
        )
        self.assertEqual(create_resp.status_code, 201)
        other_id = create_resp.data["id"]
        patch_resp = self.client.patch(
            f"/authn/contact-emails/{other_id}/",
            {"email_type": "secondary"},
            format="json",
        )
        self.assertEqual(patch_resp.status_code, 400)

    def test_update_allows_secondary_to_secondary_noop(self, _mock_code, _mock_send):
        """Patching an already-secondary email to 'secondary' should succeed (no-op)."""
        contact = ContactEmail.objects.create(
            member=self.member, email_address="sec@example.com", email_type="secondary"
        )
        patch_resp = self.client.patch(
            f"/authn/contact-emails/{contact.pk}/",
            {"email_type": "secondary"},
            format="json",
        )
        self.assertEqual(patch_resp.status_code, 200)
        self.assertEqual(patch_resp.data["email_type"], "secondary")

    def test_update_other_to_secondary_when_none_exists(self, _mock_code, _mock_send):
        """Changing 'other' to 'secondary' should work when no secondary email exists."""
        contact = ContactEmail.objects.create(
            member=self.member, email_address="extra@example.com", email_type="other"
        )
        patch_resp = self.client.patch(
            f"/authn/contact-emails/{contact.pk}/",
            {"email_type": "secondary"},
            format="json",
        )
        self.assertEqual(patch_resp.status_code, 200)
        self.assertEqual(patch_resp.data["email_type"], "secondary")

    def test_create_secondary_after_deleting_previous(self, _mock_code, _mock_send):
        """After deleting the secondary, creating a new one should succeed."""
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "sec1@example.com", "email_type": "secondary"},
            format="json",
        )
        self.assertEqual(create_resp.status_code, 201)
        sec_id = create_resp.data["id"]

        delete_resp = self.client.delete(f"/authn/contact-emails/{sec_id}/")
        self.assertEqual(delete_resp.status_code, 204)

        new_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "sec2@example.com", "email_type": "secondary"},
            format="json",
        )
        self.assertEqual(new_resp.status_code, 201)
        self.assertEqual(new_resp.data["email_type"], "secondary")

    def test_secondary_constraint_is_per_member(self, _mock_code, _mock_send):
        """Another member's secondary should not block this member from creating one."""
        ContactEmail.objects.create(
            member=self.other_member, email_address="other-sec@example.com", email_type="secondary"
        )
        response = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "my-sec@example.com", "email_type": "secondary"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["email_type"], "secondary")

    def test_make_primary_from_secondary_no_false_demotion(self, _mock_code, _mock_send):
        """Promoting the secondary itself should not trigger a spurious demotion to 'other'."""
        secondary = ContactEmail.objects.create(
            member=self.member,
            email_address="sec@example.com",
            email_type="secondary",
            verified=True,
        )

        make_resp = self.client.post(f"/authn/contact-emails/{secondary.pk}/make-primary/")
        self.assertEqual(make_resp.status_code, 200)
        self.assertEqual(make_resp.data["email_type"], "primary")

        old_primary = ContactEmail.objects.get(email_address="primary@example.com")
        self.assertEqual(old_primary.email_type, "secondary")

        # Only two emails — neither should be "other"
        self.assertEqual(
            ContactEmail.objects.filter(member=self.member, email_type="other").count(), 0
        )

    def test_make_primary_cascades_demotion_when_secondary_exists(self, _mock_code, _mock_send):
        # Setup: primary + secondary + verified other
        ContactEmail.objects.create(
            member=self.member,
            email_address="sec@example.com",
            email_type="secondary",
            verified=True,
        )
        third = ContactEmail.objects.create(
            member=self.member, email_address="third@example.com", email_type="other", verified=True
        )

        make_resp = self.client.post(f"/authn/contact-emails/{third.pk}/make-primary/")
        self.assertEqual(make_resp.status_code, 200)
        self.assertEqual(make_resp.data["email_type"], "primary")

        # Old primary → secondary, old secondary → other
        old_primary = ContactEmail.objects.get(email_address="primary@example.com")
        self.assertEqual(old_primary.email_type, "secondary")
        old_secondary = ContactEmail.objects.get(email_address="sec@example.com")
        self.assertEqual(old_secondary.email_type, "other")
