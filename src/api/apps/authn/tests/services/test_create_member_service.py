"""Tests for CreateMemberService."""

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.authn.services.members.create import CreateMemberService

Member = get_user_model()


class CreateMemberServiceTests(TestCase):
    def test_create_member_success(self):
        result = CreateMemberService.create_member(
            password="StrongPass123!",
            first_name="Alice",
            last_name="Smith",
            email="alice@example.com",
        )
        self.assertTrue(result["success"])
        self.assertIsNotNone(result["member"])
        self.assertIsNotNone(result["member_uuid"])
        self.assertIsNone(result["error"])

    def test_missing_password_returns_error(self):
        result = CreateMemberService.create_member(
            password="",
            first_name="Alice",
            last_name="Smith",
        )
        self.assertFalse(result["success"])
        self.assertIn("Password", result["error"])

    def test_missing_first_name_returns_error(self):
        result = CreateMemberService.create_member(
            password="StrongPass123!",
            first_name="",
            last_name="Smith",
        )
        self.assertFalse(result["success"])
        self.assertIn("First name", result["error"])

    def test_missing_last_name_returns_error(self):
        result = CreateMemberService.create_member(
            password="StrongPass123!",
            first_name="Alice",
            last_name="",
        )
        self.assertFalse(result["success"])
        self.assertIn("Last name", result["error"])

    def test_duplicate_email_returns_error(self):
        CreateMemberService.create_member(
            password="StrongPass123!",
            first_name="Alice",
            last_name="Smith",
            email="dup@example.com",
        )
        result = CreateMemberService.create_member(
            password="StrongPass123!",
            first_name="Bob",
            last_name="Jones",
            email="dup@example.com",
        )
        self.assertFalse(result["success"])
        self.assertIn("already exists", result["error"])

    def test_password_is_hashed(self):
        result = CreateMemberService.create_member(
            password="StrongPass123!",
            first_name="Alice",
            last_name="Smith",
        )
        member = result["member"]
        self.assertTrue(member.check_password("StrongPass123!"))
        self.assertNotEqual(member.password, "StrongPass123!")
