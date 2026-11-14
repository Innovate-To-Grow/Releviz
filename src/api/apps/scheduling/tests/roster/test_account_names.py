"""Roster rows named after an account follow the account's name."""

import uuid
from types import SimpleNamespace

from django.contrib import admin
from django.test import RequestFactory, TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import Member
from apps.authn.services.members.import_.operations import update_single_member
from apps.authn.tests.helpers import create_member, token_for
from apps.scheduling.models import Event, EventResultInvalidation, Participant, UserEvent
from apps.scheduling.services.account_names import sync_account_participant_names


class AccountNameTestCase(TestCase):
    def setUp(self):
        self.organizer = create_member("organizer@example.com", "Olive", "Organizer")
        self.rene = create_member("rene@example.com", "Rene", "Before")
        self.client = APIClient()

    def make_event(self, code, *, status=Event.Status.ACTIVE):
        event = Event.objects.create(
            code=code,
            name=code,
            organizer=self.organizer,
            status=status,
            access_mode="open_link",
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        UserEvent.objects.create(member=self.organizer, event=event, role="organizer")
        return event

    def as_member(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def join(self, event, member):
        self.as_member(member)
        response = self.client.post(f"/events/participants?code={event.code}", {}, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        return Participant.objects.get(event=event, member=member)

    def add_by_email(self, event, name, email):
        self.as_member(self.organizer)
        response = self.client.post(
            f"/events/participants/managed?code={event.code}",
            {
                "name": name,
                "email": email,
                "sendInvitation": False,
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertIn(response.status_code, (200, 201), response.data)
        return Participant.objects.get(event=event, member_id=response.data["participant"]["id"])

    def rename(self, member, first_name, last_name):
        self.as_member(member)
        response = self.client.patch(
            "/authn/profile/",
            {"first_name": first_name, "last_name": last_name},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)

    def roster_row(self, participant):
        self.as_member(self.organizer)
        response = self.client.get(f"/events/roster?code={participant.event.code}")
        self.assertEqual(response.status_code, 200, response.data)
        return next(
            row for row in response.data["participants"] if row["id"] == str(participant.pk)
        )

    def claimed_row(self, event, member, name):
        return Participant.objects.create(
            event=event,
            member=member,
            participant_name=name,
            response_claimed_at=timezone.now(),
        )


class SettingsRenameTests(AccountNameTestCase):
    def test_the_rows_a_person_answers_follow_their_new_name(self):
        answered = self.join(self.make_event("ANSWERED"), self.rene)
        invited = self.add_by_email(
            self.make_event("INVITED"), "Rene From Team B", "rene@example.com"
        )
        archived = self.claimed_row(
            self.make_event("ARCHIVED", status=Event.Status.ARCHIVED), self.rene, "Rene Before"
        )
        self.assertEqual(self.roster_row(answered)["name"], "Rene Before")
        self.assertFalse(self.roster_row(answered)["canOrganizerEditAvailability"])
        self.assertTrue(self.roster_row(invited)["canOrganizerEditAvailability"])
        before = {row.pk: row for row in Participant.objects.filter(member=self.rene)}
        invalidations = EventResultInvalidation.objects.count()

        self.rename(self.rene, "Rene", "After")

        for participant in (answered, archived):
            with self.subTest(event=participant.event.code):
                participant.refresh_from_db()
                self.assertEqual(participant.participant_name, "Rene After")
                self.assertEqual(participant.version, before[participant.pk].version + 1)
                self.assertGreater(participant.updated_at, before[participant.pk].updated_at)
        row = self.roster_row(answered)
        self.assertEqual(row["name"], "Rene After")
        self.assertEqual(row["version"], answered.version)
        # The organizer still answers for Rene here, so the name stays theirs.
        invited.refresh_from_db()
        self.assertEqual(invited.participant_name, "Rene From Team B")
        self.assertEqual(invited.version, before[invited.pk].version)
        # Results never show names.
        self.assertEqual(EventResultInvalidation.objects.count(), invalidations)

    def test_the_organizer_row_follows_the_organizer_account(self):
        own = self.join(self.make_event("OWNROW01"), self.organizer)
        # The organizer's own row takes the account's name even without a claim.
        Participant.objects.filter(pk=own.pk).update(response_claimed_at=None)

        self.rename(self.organizer, "Olivia", "Organizer")

        own.refresh_from_db()
        self.assertEqual(own.participant_name, "Olivia Organizer")
        self.assertEqual(self.roster_row(own)["name"], "Olivia Organizer")

    def test_saving_the_same_name_leaves_every_row_alone(self):
        answered = self.join(self.make_event("SAMENAME"), self.rene)
        Participant.objects.filter(pk=answered.pk).update(participant_name="Rene Earlier")
        answered.refresh_from_db()

        self.rename(self.rene, "Rene", "Before")

        stored = Participant.objects.get(pk=answered.pk)
        self.assertEqual(stored.participant_name, "Rene Earlier")
        self.assertEqual(stored.version, answered.version)


class SyncAccountParticipantNamesTests(AccountNameTestCase):
    def test_only_account_named_rows_change(self):
        event = self.make_event("SYNCROWS")
        claimed = self.claimed_row(event, self.rene, "Rene Old")
        managed = self.claimed_row(self.make_event("MANAGED1"), self.rene, "Grandma")
        Participant.objects.filter(pk=managed.pk).update(organizer_managed=True)
        unclaimed = Participant.objects.create(
            event=self.make_event("UNCLAIM1"), member=self.rene, participant_name="Rene?"
        )
        current = self.claimed_row(self.make_event("CURRENT1"), self.rene, "Rene Before")

        self.assertEqual(sync_account_participant_names(self.rene), 1)

        names = dict(
            Participant.objects.filter(member=self.rene).values_list("pk", "participant_name")
        )
        self.assertEqual(
            names,
            {
                claimed.pk: "Rene Before",
                managed.pk: "Grandma",
                unclaimed.pk: "Rene?",
                current.pk: "Rene Before",
            },
        )
        self.assertEqual(Participant.objects.get(pk=current.pk).version, current.version)

    def test_a_long_name_is_cut_to_the_participant_limit(self):
        row = self.claimed_row(self.make_event("LONGNAME"), self.rene, "Rene Before")
        self.rene.first_name = "R" * 150

        sync_account_participant_names(self.rene)

        row.refresh_from_db()
        self.assertEqual(row.participant_name, ("R" * 150 + " Before")[:100])

    def test_temporary_identities_and_nameless_accounts_are_left_alone(self):
        temporary = create_member(
            "tia@example.com", "Tia", "Temp", access_level=Member.AccessLevel.TEMPORARY
        )
        # No name and no email: nothing to show instead.
        nameless = Member(email="", first_name="", last_name="")
        nameless.set_unusable_password()
        nameless.save()
        event = self.make_event("LEFTALONE")
        rows = [
            self.claimed_row(event, temporary, "Tia Earlier"),
            self.claimed_row(event, nameless, "Nia Earlier"),
        ]

        for member, row in zip((temporary, nameless), rows, strict=True):
            with self.subTest(member=row.participant_name):
                self.assertEqual(sync_account_participant_names(member), 0)
                self.assertEqual(
                    Participant.objects.get(pk=row.pk).participant_name, row.participant_name
                )


class AdminRenameTests(AccountNameTestCase):
    def setUp(self):
        super().setUp()
        self.row = self.join(self.make_event("ADMINRNM"), self.rene)
        Participant.objects.filter(pk=self.row.pk).update(participant_name="Rene Earlier")
        superuser = Member.objects.create_superuser(
            password="StrongPass123!", first_name="Super", last_name="User"
        )
        self.request = RequestFactory().post("/admin/")
        self.request.user = superuser

    def row_name(self):
        return Participant.objects.get(pk=self.row.pk).participant_name

    def test_the_change_form_renames_the_rows_only_when_a_name_changed(self):
        member_admin = admin.site._registry[Member]
        self.rene.is_staff = True
        member_admin.save_model(
            self.request, self.rene, SimpleNamespace(changed_data=["is_staff"]), change=True
        )
        self.assertEqual(self.row_name(), "Rene Earlier")

        self.rene.last_name = "After"
        member_admin.save_model(
            self.request, self.rene, SimpleNamespace(changed_data=["last_name"]), change=True
        )
        self.assertEqual(self.row_name(), "Rene After")

    @override_settings(ROOT_URLCONF="config.urls", ADMIN_REQUIRE_CONFIRMATION=False)
    def test_saving_the_admin_change_page_renames_the_rows(self):
        # The real change form decides what counts as a changed name.
        self.client.credentials()
        self.client.force_login(self.request.user)
        form = {
            "first_name": "Rene",
            "middle_name": "",
            "last_name": "Before",
            "is_active": "on",
            "contact_emails-TOTAL_FORMS": "0",
            "contact_emails-INITIAL_FORMS": "0",
            "_save": "Save",
        }
        change_url = f"/admin/authn/member/{self.rene.pk}/change/"

        response = self.client.post(change_url, {**form, "is_staff": "on"})
        self.assertEqual(response.status_code, 302, response.content[:2000])
        self.assertTrue(Member.objects.get(pk=self.rene.pk).is_staff)
        self.assertEqual(self.row_name(), "Rene Earlier")

        response = self.client.post(change_url, {**form, "middle_name": "M"})
        self.assertEqual(response.status_code, 302, response.content[:2000])
        self.assertEqual(self.row_name(), "Rene M Before")

    def test_the_member_import_renames_the_rows_only_when_a_name_changed(self):
        parsed = {
            "row": 2,
            "primary_email": "rene@example.com",
            "first_name": "Rene",
            "last_name": "Before",
            "middle_name": "",
            "is_active": None,
            "is_staff": None,
            "primary_verified": True,
            "primary_subscribed": True,
            "secondary_email": None,
        }
        update_single_member(self.rene, parsed, claimed_contact_emails=set())
        self.assertEqual(self.row_name(), "Rene Earlier")

        update_single_member(self.rene, {**parsed, "last_name": "After"}, set())
        self.assertEqual(self.row_name(), "Rene After")
