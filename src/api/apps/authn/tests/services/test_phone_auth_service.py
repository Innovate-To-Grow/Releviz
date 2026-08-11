"""Unit tests for the passwordless phone-auth service + Member.get_primary_phone()."""

from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.authn.models import ContactPhone
from apps.authn.services.contacts.contact_phones import create_contact_phone
from apps.authn.services.contacts.phone_auth import PhoneAccountInactive, resolve_or_create_member_by_phone
from apps.authn.services.email.challenges import AuthChallengeInvalid

Member = get_user_model()


class ResolveOrCreateMemberByPhoneTests(TestCase):
    def test_creates_new_account_when_no_phone(self):
        member, flow = resolve_or_create_member_by_phone("2025550123", "1-US")
        self.assertEqual(flow, "register")
        self.assertTrue(member.is_active)
        self.assertTrue(member.requires_profile_completion)
        contact = ContactPhone.objects.get(phone_number="2025550123")
        self.assertEqual(contact.member_id, member.id)
        self.assertTrue(contact.verified)

    def test_normalizes_input_formats(self):
        member, flow = resolve_or_create_member_by_phone("+1 (202) 555-0123", "1-US")
        self.assertEqual(flow, "register")
        self.assertTrue(ContactPhone.objects.filter(phone_number="2025550123", member=member).exists())

    def test_logs_in_existing_active_member(self):
        existing = Member.objects.create_user(is_active=True, first_name="A", last_name="B")
        ContactPhone.objects.create(member=existing, phone_number="2025550123", region="1-US", verified=True)
        member, flow = resolve_or_create_member_by_phone("2025550123", "1-US")
        self.assertEqual(flow, "login")
        self.assertEqual(member.id, existing.id)

    def test_rejects_inactive_member_on_login_without_mutating(self):
        # A disabled account must not be silently revived by proving phone
        # ownership (mirrors the email-code login policy). The guard runs before
        # any write, so the member stays inactive and the phone stays unverified.
        existing = Member.objects.create_user(is_active=False)
        ContactPhone.objects.create(member=existing, phone_number="2025550123", region="1-US", verified=False)
        with self.assertRaises(PhoneAccountInactive):
            resolve_or_create_member_by_phone("2025550123", "1-US")
        existing.refresh_from_db()
        self.assertFalse(existing.is_active)
        self.assertFalse(ContactPhone.objects.get(phone_number="2025550123").verified)

    def test_claims_orphan_member_less_phone(self):
        ContactPhone.objects.create(member=None, phone_number="2025550123", region="1-US", verified=False)
        member, flow = resolve_or_create_member_by_phone("2025550123", "1-US")
        self.assertEqual(flow, "register")
        contact = ContactPhone.objects.get(phone_number="2025550123")
        self.assertEqual(contact.member_id, member.id)
        self.assertTrue(contact.verified)

    @patch("apps.authn.services.contacts.phone_auth.create_contact_phone", side_effect=AuthChallengeInvalid("dup"))
    def test_create_failure_without_existing_row_reraises_and_rolls_back_member(self, _mock_create):
        before = Member.objects.count()
        with self.assertRaises(AuthChallengeInvalid):
            resolve_or_create_member_by_phone("2025550123", "1-US")
        # The savepoint rollback must undo the throwaway member insert.
        self.assertEqual(Member.objects.count(), before)
        self.assertFalse(ContactPhone.objects.filter(phone_number="2025550123").exists())

    @patch("apps.authn.services.contacts.phone_auth.create_contact_phone", side_effect=AuthChallengeInvalid("dup"))
    @patch("apps.authn.services.contacts.phone_auth.ContactPhone")
    def test_create_race_refetches_existing_and_logs_in(self, mock_contact_phone, _mock_create):
        # The full first-miss/then-hit re-fetch can only be reproduced faithfully
        # with real concurrent connections (the competing INSERT lands in another
        # transaction); within one test transaction the inner savepoint would roll
        # the competitor row back. So this fully mocks the ORM to drive the
        # control flow, and ``test_duplicate_phone_raises_auth_challenge_invalid``
        # below pins the real contract the re-fetch branch depends on.
        winner = Member.objects.create_user(is_active=True, first_name="W", last_name="X")
        competitor = MagicMock()
        competitor.member = winner
        competitor.verified = True
        chain = (
            mock_contact_phone.objects.select_for_update.return_value.select_related.return_value.filter.return_value
        )
        # First lookup misses; after the unique-constraint race, the re-fetch finds the winner.
        chain.first.side_effect = [None, competitor]

        member, flow = resolve_or_create_member_by_phone("2025550123", "1-US")
        self.assertEqual(flow, "login")
        self.assertEqual(member, winner)

    def test_duplicate_phone_raises_auth_challenge_invalid(self):
        # The race-recovery branch catches AuthChallengeInvalid (not a bare
        # IntegrityError). This is a real-DB unit test of that contract: if
        # create_contact_phone ever stopped mapping the unique-phone violation to
        # AuthChallengeInvalid, the concurrent-signup recovery in
        # resolve_or_create_member_by_phone would silently break.
        first = Member.objects.create_user(is_active=True, first_name="A", last_name="B")
        create_contact_phone(member=first, phone_number="2025550123", region="1-US", subscribe=False)
        second = Member.objects.create_user(is_active=True, first_name="C", last_name="D")
        with self.assertRaises(AuthChallengeInvalid):
            create_contact_phone(member=second, phone_number="2025550123", region="1-US", subscribe=False)


class GetPrimaryPhoneTests(TestCase):
    def test_empty_when_no_phone(self):
        member = Member.objects.create_user(is_active=True)
        self.assertEqual(member.get_primary_phone(), "")

    def test_prefers_verified_phone(self):
        member = Member.objects.create_user(is_active=True)
        ContactPhone.objects.create(member=member, phone_number="2025550001", region="1-US", verified=False)
        ContactPhone.objects.create(member=member, phone_number="2025550002", region="1-US", verified=True)
        self.assertEqual(member.get_primary_phone(), "+12025550002")

    def test_falls_back_to_earliest_when_none_verified(self):
        member = Member.objects.create_user(is_active=True)
        ContactPhone.objects.create(member=member, phone_number="2025550001", region="1-US", verified=False)
        self.assertEqual(member.get_primary_phone(), "+12025550001")

    def test_uses_prefetch_cache_without_extra_queries(self):
        # Regression: the prefetch cache holds a QuerySet (no .sort()); the
        # member admin changelist prefetches contact_phones, so a list() copy
        # is required or every /admin/authn/member/ render 500s.
        member = Member.objects.create_user(is_active=True)
        ContactPhone.objects.create(member=member, phone_number="2025550001", region="1-US", verified=False)
        ContactPhone.objects.create(member=member, phone_number="2025550002", region="1-US", verified=True)

        prefetched = Member.objects.prefetch_related("contact_phones").get(pk=member.pk)
        with self.assertNumQueries(0):
            self.assertEqual(prefetched.get_primary_phone(), "+12025550002")
