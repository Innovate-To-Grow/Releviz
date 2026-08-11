"""MemberAdmin search finds members by phone (full / partial / formatted / normalized)."""

from django.contrib.admin.sites import AdminSite
from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase

from apps.authn.admin.members.member import MemberAdmin
from apps.authn.models import ContactEmail, ContactPhone

Member = get_user_model()


class MemberAdminPhoneSearchTests(TestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        self.admin = MemberAdmin(Member, AdminSite())
        self.factory = RequestFactory()
        self.member = Member.objects.create_user(is_active=True, first_name="Ada", last_name="Lovelace")
        ContactEmail.objects.create(
            member=self.member, email_address="ada@example.com", email_type="primary", verified=True
        )
        ContactPhone.objects.create(member=self.member, phone_number="5551234567", region="1-US", verified=True)

    def _search(self, term):
        request = self.factory.get("/admin/authn/member/", {"q": term})
        queryset, _ = self.admin.get_search_results(request, Member.objects.all(), term)
        return list(queryset.distinct())

    def test_full_phone_number_matches(self):
        for term in ("5551234567", "+1 555 123 4567", "15551234567"):
            with self.subTest(term=term):
                self.assertIn(self.member, self._search(term))

    def test_partial_phone_digits_match(self):
        self.assertIn(self.member, self._search("555123"))
        self.assertIn(self.member, self._search("1234567"))

    def test_formatted_input_matches(self):
        self.assertIn(self.member, self._search("(555) 123-4567"))

    def test_email_and_name_search_preserved(self):
        self.assertIn(self.member, self._search("ada@example.com"))
        self.assertIn(self.member, self._search("Lovelace"))

    def test_no_duplicate_members_with_multiple_matching_phones(self):
        ContactPhone.objects.create(member=self.member, phone_number="5559998888", region="1-US", verified=True)
        results = self._search("555")
        self.assertEqual([m.id for m in results].count(self.member.id), 1)

    def test_unrelated_term_returns_no_match(self):
        self.assertNotIn(self.member, self._search("zzzznomatch"))


class MemberAdminChangelistRenderTests(TestCase):
    """Render the real changelist page — list_display callables run against the
    prefetched queryset here, which unit tests on the admin class never exercise."""

    def test_changelist_renders_with_contact_phones(self):
        from apps.event.tests.helpers import make_superuser

        member = Member.objects.create_user(is_active=True, first_name="Ada", last_name="Lovelace")
        ContactPhone.objects.create(member=member, phone_number="5551234567", region="1-US", verified=True)

        self.client.force_login(make_superuser())
        response = self.client.get("/admin/authn/member/")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "+15551234567")
