"""Model-level coverage for authn models."""

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.test import TestCase

from apps.authn.models import (
    ContactEmail,
    ImpersonationToken,
    RSAKeypair,
)

Member = get_user_model()


def _member(first="A", last="B", **kw):
    return Member.objects.create_user(password="StrongPass123!", first_name=first, last_name=last, **kw)


class ContactEmailModelTests(TestCase):
    def test_clean_rejects_same_member_duplicate(self):
        member = _member()
        ContactEmail.objects.create(member=member, email_address="dup@example.com", email_type="secondary")
        dup = ContactEmail(member=member, email_address="dup@example.com", email_type="other")
        with self.assertRaises(ValidationError) as ctx:
            dup.clean()
        self.assertIn("already has this email address", str(ctx.exception))

    def test_clean_rejects_other_member_duplicate(self):
        m1 = _member()
        m2 = _member(first="C", last="D")
        ContactEmail.objects.create(member=m1, email_address="shared@example.com", email_type="primary")
        dup = ContactEmail(member=m2, email_address="shared@example.com", email_type="secondary")
        with self.assertRaises(ValidationError) as ctx:
            dup.clean()
        self.assertIn("already assigned to another member", str(ctx.exception))

    def test_clean_rejects_second_primary(self):
        member = _member()
        ContactEmail.objects.create(member=member, email_address="p1@example.com", email_type="primary")
        second = ContactEmail(member=member, email_address="p2@example.com", email_type="primary")
        with self.assertRaises(ValidationError) as ctx:
            second.clean()
        self.assertIn("already has a primary email", str(ctx.exception))

    def test_str_includes_subscribe_and_verified(self):
        member = _member()
        email = ContactEmail.objects.create(
            member=member, email_address="s@example.com", email_type="primary", subscribe=True, verified=True
        )
        text = str(email)
        self.assertIn("Subscribed", text)
        self.assertIn("Verified", text)


class MemberManagerTests(TestCase):
    def test_create_superuser_rejects_non_staff(self):
        with self.assertRaisesMessage(ValueError, "Superuser must have is_staff=True."):
            Member.objects.create_superuser(password="StrongPass123!", first_name="A", last_name="B", is_staff=False)

    def test_create_superuser_rejects_non_superuser(self):
        with self.assertRaisesMessage(ValueError, "Superuser must have is_superuser=True."):
            Member.objects.create_superuser(
                password="StrongPass123!", first_name="A", last_name="B", is_superuser=False
            )


class ImpersonationTokenModelTests(TestCase):
    def test_str_active(self):
        member = _member()
        admin = _member(first="Ad", last="Min", is_staff=True)
        token = ImpersonationToken.objects.create(
            token=ImpersonationToken.generate_token(), member=member, created_by=admin
        )
        self.assertIn("active", str(token))

    def test_str_used(self):
        member = _member()
        admin = _member(first="Ad", last="Min", is_staff=True)
        token = ImpersonationToken.objects.create(
            token=ImpersonationToken.generate_token(), member=member, created_by=admin
        )
        token.mark_used()
        self.assertIn("used", str(token))


class RSAKeypairModelTests(TestCase):
    def test_str(self):
        keypair = RSAKeypair.objects.create(name="my-key")
        self.assertIn("my-key", str(keypair))

    def test_deactivate(self):
        keypair = RSAKeypair.objects.create(name="my-key", is_active=True)
        keypair.deactivate()
        keypair.refresh_from_db()
        self.assertFalse(keypair.is_active)
        self.assertIsNotNone(keypair.rotated_at)
