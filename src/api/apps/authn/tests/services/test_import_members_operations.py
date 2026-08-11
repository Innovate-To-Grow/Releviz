"""Direct coverage for import_members.operations.update_single_member."""

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.authn.models import ContactEmail
from apps.authn.services.members.import_.operations import update_single_member

Member = get_user_model()


def _parsed(**overrides):
    base = {
        "row": 2,
        "primary_email": "user@example.com",
        "first_name": "New",
        "last_name": "Name",
        "middle_name": "",
        "title": "",
        "organization": "",
        "is_active": None,
        "is_staff": None,
        "date_joined": None,
        "primary_verified": True,
        "primary_subscribed": True,
        "secondary_email": None,
        "secondary_verified": False,
        "secondary_subscribed": False,
    }
    base.update(overrides)
    return base


class UpdateSingleMemberTests(TestCase):
    def setUp(self):
        self.member = Member.objects.create_user(
            password="StrongPass123!", first_name="Old", last_name="Name", is_active=True
        )
        self.primary = ContactEmail.objects.create(
            member=self.member, email_address="user@example.com", email_type="primary", verified=False
        )

    def test_updates_all_optional_fields(self):
        # Exercises the middle_name/title/organization/is_active/is_staff branches.
        parsed = _parsed(
            middle_name="Quincy",
            title="Engineer",
            organization="Acme",
            is_active=True,
            is_staff=True,
        )
        update_single_member(self.member, parsed, claimed_contact_emails=set())
        self.member.refresh_from_db()
        self.assertEqual(self.member.middle_name, "Quincy")
        self.assertEqual(self.member.title, "Engineer")
        self.assertEqual(self.member.organization, "Acme")
        self.assertTrue(self.member.is_staff)

    def test_primary_email_updated_when_not_claimed(self):
        # Empty claimed set -> takes the "update existing primary contact" branch (lines 63-68).
        parsed = _parsed(primary_verified=True, primary_subscribed=False)
        update_single_member(self.member, parsed, claimed_contact_emails=set())
        self.primary.refresh_from_db()
        self.assertTrue(self.primary.verified)
        self.assertFalse(self.primary.subscribe)

    def test_primary_email_created_when_member_has_none(self):
        # Member with no primary contact -> create branch (lines 70-76).
        bare = Member.objects.create_user(password="StrongPass123!", first_name="No", last_name="Email")
        parsed = _parsed(primary_email="fresh@example.com")
        update_single_member(bare, parsed, claimed_contact_emails=set())
        self.assertTrue(ContactEmail.objects.filter(member=bare, email_type="primary").exists())

    def test_secondary_email_existing_updated(self):
        # Pre-existing record with the same address -> existing_sec update branch (lines 95-98).
        ContactEmail.objects.create(
            member=self.member, email_address="sec@example.com", email_type="other", verified=False
        )
        parsed = _parsed(secondary_email="sec@example.com", secondary_verified=True)
        update_single_member(self.member, parsed, claimed_contact_emails=set())
        sec = ContactEmail.objects.get(member=self.member, email_address="sec@example.com")
        self.assertEqual(sec.email_type, "secondary")
        self.assertTrue(sec.verified)

    def test_update_single_member_returns_member(self):
        parsed = _parsed()
        result = update_single_member(self.member, parsed, claimed_contact_emails=set())
        self.assertEqual(result, self.member)
