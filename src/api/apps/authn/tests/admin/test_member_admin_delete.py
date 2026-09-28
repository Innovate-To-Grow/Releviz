"""Deleting a member in the admin.

The Contact Email admin refuses to delete a primary email on its own, and that
refusal used to count against the member it belongs to, so nobody, not even a
superuser, could delete a member with one. The admin delete also goes through
the account-deletion service, so it leaves what deleting the account in
Settings leaves.
"""

from datetime import timedelta

from django.core.cache import cache
from django.test import TestCase, override_settings
from django.urls import reverse

from apps.authn.models import ContactEmail, Member
from apps.scheduling.models import Event, EventResultInvalidation, Participant

DAY = timedelta(days=1)


def _member(email, **kwargs):
    member = Member.objects.create_user(password="StrongPass123!", is_active=True, **kwargs)
    ContactEmail.objects.create(
        member=member, email_address=email, email_type="primary", verified=True
    )
    return member


def _event(code, organizer):
    return Event.objects.create(
        code=code,
        name=code,
        organizer=organizer,
        days=[1],
        start_minutes=9 * 60,
        end_minutes=10 * 60,
    )


@override_settings(ROOT_URLCONF="config.urls", ADMIN_REQUIRE_CONFIRMATION=False)
class MemberAdminDeleteTests(TestCase):
    def setUp(self):
        cache.clear()
        self.superuser = Member.objects.create_superuser(
            password="StrongPass123!", first_name="Super", last_name="User", is_active=True
        )
        self.authn_admin = _member(
            "authn-admin@example.com",
            first_name="Authn",
            last_name="Admin",
            is_staff=True,
            admin_apps=["authn"],
        )
        self.target = _member("target@example.com", first_name="Tara", last_name="Target")
        ContactEmail.objects.create(
            member=self.target,
            email_address="target-secondary@example.com",
            email_type="secondary",
            verified=True,
        )

    def tearDown(self):
        cache.clear()

    @staticmethod
    def _delete_url(member):
        return reverse("admin:authn_member_delete", args=[member.pk])

    def _bulk_delete(self, members):
        return self.client.post(
            reverse("admin:authn_member_changelist"),
            {
                "action": "delete_selected",
                "index": "0",
                "post": "yes",
                "_selected_action": [str(member.pk) for member in members],
            },
        )

    def _target_emails(self):
        return ContactEmail.objects.filter(email_address__startswith="target")

    def _organizer_and_participant(self):
        """Make the target organize an event with a managed person and answer another."""
        organized = _event("ADMDEL1", self.target)
        managed = Member.objects.create_user(
            email="", first_name="Managed", is_active=True, access_level="temporary"
        )
        Participant.objects.create(
            member=managed,
            event=organized,
            participant_name="Managed Person",
            contact_email="target@example.com",
            organizer_managed=True,
        )
        answered = _event("ADMDEL2", self.superuser)
        Participant.objects.create(
            member=self.target, event=answered, participant_name="Tara Target"
        )
        return organized, managed, answered

    def test_superuser_deletes_a_member_with_their_primary_email(self):
        self.client.force_login(self.superuser)
        response = self.client.get(self._delete_url(self.target))
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.context["perms_lacking"])
        self.assertContains(response, "target@example.com")

        response = self.client.post(self._delete_url(self.target), {"post": "yes"})

        self.assertRedirects(
            response, reverse("admin:authn_member_changelist"), fetch_redirect_response=False
        )
        self.assertFalse(Member.objects.filter(pk=self.target.pk).exists())
        self.assertFalse(self._target_emails().exists())

    def test_a_primary_email_alone_still_cannot_be_deleted(self):
        primary = ContactEmail.objects.get(email_address="target@example.com")
        self.client.force_login(self.superuser)
        url = reverse("admin:authn_contactemail_delete", args=[primary.pk])
        self.assertEqual(self.client.post(url, {"post": "yes"}).status_code, 403)
        self.assertTrue(ContactEmail.objects.filter(pk=primary.pk).exists())

    def test_authn_admin_deletes_a_regular_member_but_not_a_privileged_one(self):
        staff = _member("staff@example.com", is_staff=True, admin_apps=["core"])
        self.client.force_login(self.authn_admin)

        self.assertEqual(
            self.client.post(self._delete_url(staff), {"post": "yes"}).status_code, 403
        )
        response = self.client.post(self._delete_url(self.target), {"post": "yes"})

        self.assertEqual(response.status_code, 302)
        self.assertFalse(Member.objects.filter(pk=self.target.pk).exists())
        self.assertFalse(self._target_emails().exists())
        self.assertTrue(Member.objects.filter(pk=staff.pk).exists())

    def test_only_the_contact_emails_are_waived_for_an_authn_admin(self):
        # The target's events and answers belong to the scheduling app, which
        # this admin was not granted: those still stop the delete.
        self._organizer_and_participant()
        self.client.force_login(self.authn_admin)

        response = self.client.get(self._delete_url(self.target))

        self.assertEqual(response.status_code, 200)
        self.assertIn("participant", response.context["perms_lacking"])
        self.assertIn("event", response.context["perms_lacking"])
        self.assertNotIn("Contact Email", response.context["perms_lacking"])
        self.assertEqual(
            self.client.post(self._delete_url(self.target), {"post": "yes"}).status_code, 403
        )
        self.assertTrue(Member.objects.filter(pk=self.target.pk).exists())
        self.assertEqual(self._target_emails().count(), 2)

    def test_bulk_delete_takes_the_members_with_their_primary_emails(self):
        other = _member("target-other@example.com")
        self.client.force_login(self.superuser)

        response = self._bulk_delete([self.target, other])

        self.assertEqual(response.status_code, 302)
        self.assertFalse(Member.objects.filter(pk__in=[self.target.pk, other.pk]).exists())
        self.assertFalse(self._target_emails().exists())

    def test_bulk_delete_with_a_privileged_account_is_refused_for_a_non_superuser(self):
        staff = _member("staff@example.com", is_staff=True)
        self.client.force_login(self.authn_admin)

        self.assertEqual(self._bulk_delete([self.target, staff]).status_code, 403)

        self.assertEqual(Member.objects.filter(pk__in=[self.target.pk, staff.pk]).count(), 2)
        self.assertEqual(self._target_emails().count(), 2)

    def test_delete_goes_through_account_deletion(self):
        organized, managed, answered = self._organizer_and_participant()
        invalidations = EventResultInvalidation.objects.filter(event=answered).count()
        self.client.force_login(self.superuser)

        self.client.post(self._delete_url(self.target), {"post": "yes"})

        self.assertFalse(Event.objects.filter(pk=organized.pk).exists())
        # The organizer-managed person existed only for the deleted event.
        self.assertFalse(Member.objects.filter(pk=managed.pk).exists())
        self.assertFalse(Participant.objects.filter(event=answered).exists())
        self.assertEqual(
            EventResultInvalidation.objects.filter(event=answered).count(), invalidations + 1
        )

    def test_bulk_delete_goes_through_account_deletion(self):
        organized, managed, answered = self._organizer_and_participant()
        other = _member("target-other@example.com")
        invalidations = EventResultInvalidation.objects.filter(event=answered).count()
        self.client.force_login(self.superuser)

        self.assertEqual(self._bulk_delete([self.target, other]).status_code, 302)

        self.assertFalse(Member.objects.filter(pk__in=[self.target.pk, other.pk]).exists())
        self.assertFalse(Event.objects.filter(pk=organized.pk).exists())
        self.assertFalse(Member.objects.filter(pk=managed.pk).exists())
        self.assertEqual(
            EventResultInvalidation.objects.filter(event=answered).count(), invalidations + 1
        )

    def test_bulk_delete_of_an_organizer_and_their_managed_person_together(self):
        organized, managed, _answered = self._organizer_and_participant()
        # The list shows newest first: the organizer's deletion removes the
        # managed person before the loop reaches them.
        Member.objects.filter(pk=managed.pk).update(date_joined=self.target.date_joined - DAY)
        self.client.force_login(self.superuser)

        self.assertEqual(self._bulk_delete([managed, self.target]).status_code, 302)

        self.assertFalse(Member.objects.filter(pk__in=[self.target.pk, managed.pk]).exists())
        self.assertFalse(Event.objects.filter(pk=organized.pk).exists())

    @override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
    def test_superuser_deletes_a_member_through_the_typed_confirmation(self):
        self.client.force_login(self.superuser)
        confirm_url = reverse("admin:authn_member_confirm_change")

        response = self.client.post(self._delete_url(self.target), {"post": "yes"})
        self.assertRedirects(response, confirm_url, fetch_redirect_response=False)
        token = self.client.session["_admin_pending_change_authn_member"]["token"]
        response = self.client.post(confirm_url, {"token": token, "confirmation_word": "user"})

        self.assertRedirects(
            response, reverse("admin:authn_member_changelist"), fetch_redirect_response=False
        )
        self.assertFalse(Member.objects.filter(pk=self.target.pk).exists())
        self.assertFalse(self._target_emails().exists())

    @override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
    def test_superuser_bulk_deletes_members_through_the_typed_confirmation(self):
        other = _member("target-other@example.com")
        self.client.force_login(self.superuser)
        confirm_url = reverse("admin:authn_member_confirm_action")

        response = self._bulk_delete([self.target, other])
        self.assertRedirects(response, confirm_url, fetch_redirect_response=False)
        self.assertContains(self.client.get(confirm_url), "Confirm Action: Delete selected users")
        token = self.client.session["_admin_pending_action_authn_member"]["token"]
        response = self.client.post(
            confirm_url, {"token": token, "confirmation_word": "user"}, follow=True
        )

        self.assertContains(response, "Successfully deleted 2 users.")
        self.assertFalse(Member.objects.filter(pk__in=[self.target.pk, other.pk]).exists())
        self.assertFalse(self._target_emails().exists())
