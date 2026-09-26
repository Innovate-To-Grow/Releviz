"""Organizer corrections to single roster entries, their own row, and group inclusion."""

import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail
from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob
from apps.scheduling.models import (
    Event,
    EventInvitation,
    Participant,
    ParticipantGroup,
    TemporaryEventSession,
    UserEvent,
    Weight,
)
from apps.scheduling.services.roster_groups import ensure_groups
from apps.scheduling.services.roster_imports.mapping import auto_mapping
from apps.scheduling.services.roster_people import (
    EMAIL_LOCKED_MESSAGE,
    EMAIL_SENDING_MESSAGE,
    OWN_ADDRESS_MESSAGE,
    OWN_ROW_EMAIL_MESSAGE,
)

ORGANIZER_EMAIL = "organizer@example.com"


class RosterPeopleTestCase(TestCase):
    def setUp(self):
        self.organizer = create_member(ORGANIZER_EMAIL, "Olive", "Organizer")
        self.client = APIClient()
        self.authenticate(self.organizer)
        self.event = Event.objects.create(
            code="PEOPLE01",
            name="Capstone",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            access_mode="invite_only",
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        UserEvent.objects.create(member=self.organizer, event=self.event, role="organizer")

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def add_person(self, name, email="", *, managed=False, send=False):
        response = self.client.post(
            f"/events/participants/managed?code={self.event.code}",
            {
                "name": name,
                "email": email,
                "organizerManaged": managed,
                "sendInvitation": send,
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertIn(response.status_code, (200, 201), response.data)
        return Participant.objects.get(
            event=self.event, member_id=response.data["participant"]["id"]
        )

    def roster(self):
        response = self.client.get(f"/events/roster?code={self.event.code}")
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def row(self, participant):
        return next(
            item for item in self.roster()["participants"] if item["id"] == str(participant.pk)
        )

    def patch(self, participant, payload, *, code=None):
        participant.refresh_from_db()
        return self.client.patch(
            f"/events/roster/{participant.pk}?code={code or self.event.code}",
            {"expectedVersion": participant.version, **payload},
            format="json",
        )

    def delete(self, participant_id, *, code=None):
        return self.client.delete(f"/events/roster/{participant_id}?code={code or self.event.code}")

    def session_for(self, participant):
        invitation = EventInvitation.objects.get(event=self.event, member=participant.member)
        return TemporaryEventSession.objects.create(
            member=participant.member,
            participant=participant,
            invitation=invitation,
            secret_hash=uuid.uuid4().hex * 2,
            expires_at=timezone.now() + timedelta(days=1),
        )

    def invitation_jobs(self, participant):
        return EmailDeliveryJob.objects.filter(
            invitation__event=self.event, invitation__member=participant.member
        )


class RemoveParticipantTests(RosterPeopleTestCase):
    def test_removing_a_person_deletes_their_row_invitation_and_queued_email(self):
        ada = self.add_person("Ada", "ada@example.com", send=True)
        bob = self.add_person("Bob", "bob@example.com")
        group = ensure_groups(event=self.event, names=["Team 1"])[0]
        ada.groups.add(group)
        Weight.objects.create(event=self.event, participant=ada, weight=0.5)
        invitation = EventInvitation.objects.get(event=self.event, member=ada.member)
        self.session_for(ada)
        job = EmailDeliveryJob.objects.get(invitation=invitation)
        self.assertEqual(job.status, EmailDeliveryJob.Status.PENDING)
        revision = Event.objects.get(pk=self.event.pk).results_revision

        response = self.delete(ada.pk)

        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["deleted"])
        self.assertEqual(response.data["resultsRevision"], revision + 1)
        self.assertEqual(
            response.data["groups"],
            [
                {
                    "id": group.pk,
                    "name": "Team 1",
                    "count": 0,
                    "weight": None,
                    "included": None,
                },
                {"id": None, "name": "", "count": 1, "weight": 1.0, "included": True},
            ],
        )
        self.assertFalse(Participant.objects.filter(pk=ada.pk).exists())
        self.assertFalse(EventInvitation.objects.filter(pk=invitation.pk).exists())
        self.assertFalse(Weight.objects.filter(participant_id=ada.pk).exists())
        self.assertFalse(TemporaryEventSession.objects.filter(member=ada.member).exists())
        self.assertFalse(
            UserEvent.objects.filter(
                event=self.event, member=ada.member, role="participant"
            ).exists()
        )
        job.refresh_from_db()
        self.assertEqual(job.status, EmailDeliveryJob.Status.CANCELED)
        self.assertIsNone(job.invitation_id)
        # Their account (a temporary identity with its own address) stays.
        self.assertTrue(get_user_model().objects.filter(pk=ada.member_id).exists())
        # Everyone else is untouched.
        self.assertTrue(Participant.objects.filter(pk=bob.pk).exists())
        self.assertEqual([row["name"] for row in self.roster()["participants"]], ["Bob"])
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 1)

    def test_removing_a_person_with_no_email_deletes_their_backing_member(self):
        managed = self.add_person("Grandma", managed=True)
        member_id = managed.member_id

        response = self.delete(managed.pk)

        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(get_user_model().objects.filter(pk=member_id).exists())
        self.assertEqual(response.data["groups"], [])

    def test_the_organizer_can_remove_their_own_row(self):
        joined = self.client.post(f"/events/participants?code={self.event.code}", {}, format="json")
        self.assertEqual(joined.status_code, 201, joined.data)
        own = Participant.objects.get(event=self.event, member=self.organizer)

        response = self.delete(own.pk)

        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(Participant.objects.filter(pk=own.pk).exists())
        self.assertTrue(
            UserEvent.objects.filter(
                event=self.event, member=self.organizer, role="organizer"
            ).exists()
        )
        self.assertFalse(self.roster()["organizerOnRoster"])

    def test_an_email_being_sent_blocks_the_removal(self):
        ada = self.add_person("Ada", "ada@example.com", send=True)
        self.invitation_jobs(ada).update(status=EmailDeliveryJob.Status.PROCESSING)

        response = self.delete(ada.pk)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error"], EMAIL_SENDING_MESSAGE)
        self.assertTrue(Participant.objects.filter(pk=ada.pk).exists())
        self.assertTrue(EventInvitation.objects.filter(member=ada.member).exists())

    def test_sent_and_failed_emails_are_left_as_they_were(self):
        ada = self.add_person("Ada", "ada@example.com", send=True)
        self.invitation_jobs(ada).update(status=EmailDeliveryJob.Status.SENT)
        job = self.invitation_jobs(ada).get()

        self.assertEqual(self.delete(ada.pk).status_code, 200)

        job.refresh_from_db()
        self.assertEqual(job.status, EmailDeliveryJob.Status.SENT)

    def test_removal_guards(self):
        ada = self.add_person("Ada", "ada@example.com")
        self.assertEqual(self.delete(ada.pk, code="MISSING1").status_code, 404)
        self.assertEqual(self.delete("999999").status_code, 404)
        self.assertEqual(self.client.delete(f"/events/roster/{ada.pk}").status_code, 400)

        outsider = create_member("outsider@example.com", "Out", "Sider")
        self.authenticate(outsider)
        self.assertEqual(self.delete(ada.pk).status_code, 403)

        self.authenticate(self.organizer)
        Event.objects.filter(pk=self.event.pk).update(status=Event.Status.CLOSED)
        self.assertEqual(self.delete(ada.pk).status_code, 409)
        self.assertTrue(Participant.objects.filter(pk=ada.pk).exists())


class ChangeParticipantEmailTests(RosterPeopleTestCase):
    def test_a_mistyped_address_moves_the_row_to_a_new_identity(self):
        ada = self.add_person("Ada", "ada@exmaple.com", send=True)
        group = ensure_groups(event=self.event, names=["Team 1"])[0]
        ada.groups.add(group)
        Weight.objects.create(event=self.event, participant=ada, weight=0.25)
        Participant.objects.filter(pk=ada.pk).update(availability_inperson=[1, 1])
        old_member_id = ada.member_id
        old_invitation = EventInvitation.objects.get(event=self.event, member_id=old_member_id)
        old_job = EmailDeliveryJob.objects.get(invitation=old_invitation)
        revision = Event.objects.get(pk=self.event.pk).results_revision
        self.assertTrue(self.row(ada)["canOrganizerEditEmail"])
        version = Participant.objects.get(pk=ada.pk).version

        response = self.patch(ada, {"email": " Ada@Example.com "})

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["resultsRevision"], revision + 1)
        row = response.data["participant"]
        self.assertEqual(row["email"], "ada@example.com")
        self.assertEqual(row["name"], "Ada")
        self.assertEqual(row["invitationStatus"], "not_sent")
        self.assertEqual(row["groups"], [{"id": group.pk, "name": "Team 1"}])
        self.assertEqual(row["weight"], 0.25)
        self.assertEqual(row["accountAccess"], "temporary")
        self.assertTrue(row["canOrganizerEditEmail"])
        self.assertEqual(row["version"], version + 1)
        ada.refresh_from_db()
        self.assertNotEqual(ada.member_id, old_member_id)
        self.assertEqual(ada.availability_inperson, [1, 1])
        self.assertEqual(ada.member.email, "ada@example.com")
        self.assertFalse(EventInvitation.objects.filter(pk=old_invitation.pk).exists())
        new_invitation = EventInvitation.objects.get(event=self.event, member=ada.member)
        self.assertEqual(new_invitation.email, "ada@example.com")
        self.assertIsNone(new_invitation.first_sent_at)
        self.assertEqual(new_invitation.invited_by, self.organizer)
        old_job.refresh_from_db()
        self.assertEqual(old_job.status, EmailDeliveryJob.Status.CANCELED)
        self.assertFalse(
            UserEvent.objects.filter(event=self.event, member_id=old_member_id).exists()
        )
        self.assertTrue(
            UserEvent.objects.filter(
                event=self.event, member=ada.member, role="participant"
            ).exists()
        )

    def test_the_same_address_changes_nothing(self):
        ada = self.add_person("Ada", "ada@example.com")
        version = Participant.objects.get(pk=ada.pk).version
        revision = Event.objects.get(pk=self.event.pk).results_revision

        response = self.patch(ada, {"email": "ADA@example.com"})

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["participant"]["version"], version)
        self.assertEqual(response.data["resultsRevision"], revision)

    def test_an_existing_account_takes_over_the_row_until_they_answer(self):
        ada = self.add_person("Ada", "ada.old@example.com")
        account = create_member("ada@example.com", "Ada", "Lovelace")

        response = self.patch(ada, {"email": "ada@example.com"})

        self.assertEqual(response.status_code, 200, response.data)
        row = response.data["participant"]
        self.assertEqual(row["memberId"], str(account.pk))
        self.assertEqual(row["accountAccess"], "full")
        self.assertTrue(row["canOrganizerEditAvailability"])

    def test_another_address_of_the_same_account_keeps_the_member(self):
        account = create_member("ada@example.com", "Ada", "Lovelace")
        ContactEmail.objects.create(
            member=account,
            email_address="ada@work.example.com",
            email_type="secondary",
            verified=True,
        )
        ada = self.add_person("Ada", "ada@example.com")

        response = self.patch(ada, {"email": "ada@work.example.com"})

        self.assertEqual(response.status_code, 200, response.data)
        ada.refresh_from_db()
        self.assertEqual(ada.member_id, account.pk)
        self.assertEqual(
            list(EventInvitation.objects.filter(event=self.event).values_list("email", flat=True)),
            ["ada@work.example.com"],
        )
        self.assertEqual(
            UserEvent.objects.filter(event=self.event, member=account, role="participant").count(),
            1,
        )

    def test_a_person_with_no_email_becomes_invitable(self):
        managed = self.add_person("Grandma", managed=True)
        old_member_id = managed.member_id
        self.assertTrue(self.row(managed)["canOrganizerEditEmail"])

        response = self.patch(managed, {"email": "grandma@example.com"})

        self.assertEqual(response.status_code, 200, response.data)
        row = response.data["participant"]
        self.assertFalse(row["organizerManaged"])
        self.assertEqual(row["email"], "grandma@example.com")
        self.assertEqual(row["invitationStatus"], "not_sent")
        managed.refresh_from_db()
        self.assertEqual(managed.contact_email, "")
        self.assertFalse(get_user_model().objects.filter(pk=old_member_id).exists())
        self.assertTrue(
            EventInvitation.objects.filter(
                event=self.event, email="grandma@example.com", member=managed.member
            ).exists()
        )

    def test_a_leftover_invitation_for_the_new_address_is_replaced(self):
        ada = self.add_person("Ada", "ada@exmaple.com")
        stale = EventInvitation.objects.create(
            event=self.event, email="ada@example.com", first_sent_at=timezone.now()
        )

        response = self.patch(ada, {"email": "ada@example.com"})

        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(EventInvitation.objects.filter(pk=stale.pk).exists())
        replacement = EventInvitation.objects.get(event=self.event, email="ada@example.com")
        self.assertIsNone(replacement.first_sent_at)

    def test_invalid_addresses_are_refused(self):
        ada = self.add_person("Ada", "ada@example.com")
        for value, message in (
            ("", "Email is required."),
            (None, "Email is required."),
            ("not-an-address", "Enter a valid email address."),
            (f"{'a' * 250}@example.com", "Email is too long (max 254)."),
        ):
            with self.subTest(value=value):
                response = self.patch(ada, {"email": value})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.data["error"], message)

    def test_conflicting_addresses_are_refused(self):
        ada = self.add_person("Ada", "ada@example.com")
        bob = self.add_person("Bob", "bob@example.com")
        inactive = create_member("gone@example.com", "Gone", "Away", is_active=False)
        self.assertFalse(inactive.is_active)

        taken = self.patch(bob, {"email": "ada@example.com"})
        own = self.patch(bob, {"email": ORGANIZER_EMAIL})
        gone = self.patch(bob, {"email": "gone@example.com"})

        self.assertEqual(taken.status_code, 409)
        self.assertEqual(taken.data["error"], "ada@example.com is already a participant.")
        self.assertEqual(own.status_code, 409)
        self.assertEqual(own.data["error"], OWN_ADDRESS_MESSAGE)
        self.assertEqual(gone.status_code, 409)
        self.assertEqual(gone.data["error"], "This email belongs to an inactive account.")
        bob.refresh_from_db()
        self.assertEqual(
            EventInvitation.objects.get(event=self.event, member=bob.member).email,
            "bob@example.com",
        )
        self.assertTrue(Participant.objects.filter(pk=ada.pk).exists())

    @override_settings(INVITATION_MAX_EVENT_RECIPIENTS=1)
    def test_the_invitation_limit_still_applies(self):
        ada = self.add_person("Ada", "ada@example.com")
        EventInvitation.objects.create(event=self.event, email="someone@example.com")

        response = self.patch(ada, {"email": "ada.new@example.com"})

        self.assertEqual(response.status_code, 409)
        self.assertIn("at most 1 invitation recipients", response.data["error"])

    def test_people_who_already_acted_keep_their_address(self):
        claimed = self.add_person("Claimed", "claimed@example.com")
        Participant.objects.filter(pk=claimed.pk).update(response_claimed_at=timezone.now())
        accepted = self.add_person("Accepted", "accepted@example.com")
        EventInvitation.objects.filter(member=accepted.member).update(accepted_at=timezone.now())
        signed_in = self.add_person("Signed", "signed@example.com")
        self.session_for(signed_in)

        for participant in (claimed, accepted, signed_in):
            with self.subTest(name=participant.participant_name):
                self.assertFalse(self.row(participant)["canOrganizerEditEmail"])
                response = self.patch(participant, {"email": "new@example.com"})
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.data["error"], EMAIL_LOCKED_MESSAGE)

    def test_an_email_being_sent_blocks_the_change(self):
        ada = self.add_person("Ada", "ada@exmaple.com", send=True)
        self.invitation_jobs(ada).update(status=EmailDeliveryJob.Status.PROCESSING)

        response = self.patch(ada, {"email": "ada@example.com"})

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error"], EMAIL_SENDING_MESSAGE)
        self.assertEqual(
            EventInvitation.objects.get(event=self.event, member=ada.member).email,
            "ada@exmaple.com",
        )

    def test_the_organizer_row_keeps_the_account_address(self):
        self.client.post(f"/events/participants?code={self.event.code}", {}, format="json")
        own = Participant.objects.get(event=self.event, member=self.organizer)

        response = self.patch(own, {"email": "other@example.com"})

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error"], OWN_ROW_EMAIL_MESSAGE)

    def test_email_and_name_change_together(self):
        ada = self.add_person("Ada", "ada@exmaple.com")

        response = self.patch(ada, {"email": "ada@example.com", "name": "Ada Lovelace"})

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["participant"]["name"], "Ada Lovelace")
        self.assertEqual(response.data["participant"]["email"], "ada@example.com")


class OrganizerOwnRowTests(RosterPeopleTestCase):
    def test_the_organizer_joins_their_own_roster_and_is_never_invited(self):
        self.assertFalse(self.roster()["organizerOnRoster"])
        ada = self.add_person("Ada", "ada@example.com")

        joined = self.client.post(f"/events/participants?code={self.event.code}", {}, format="json")

        self.assertEqual(joined.status_code, 201, joined.data)
        roster = self.roster()
        self.assertTrue(roster["organizerOnRoster"])
        own = next(item for item in roster["participants"] if item["isOrganizer"])
        self.assertEqual(own["name"], "Olive Organizer")
        self.assertEqual(own["email"], ORGANIZER_EMAIL)
        self.assertFalse(own["canOrganizerEditAvailability"])
        self.assertFalse(own["canOrganizerEditEmail"])
        self.assertFalse(self.row(ada)["isOrganizer"])

        sent = self.client.post(
            f"/events/roster/invitations?code={self.event.code}",
            {
                "participantIds": [own["id"], str(ada.pk)],
                "resend": True,
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )

        self.assertEqual(sent.status_code, 202, sent.data)
        self.assertEqual(sent.data["queuedCount"], 1)
        self.assertEqual(sent.data["skippedCount"], 1)
        self.assertFalse(EventInvitation.objects.filter(email=ORGANIZER_EMAIL).exists())

    def test_an_account_without_a_member_email_shows_its_primary_contact(self):
        # Accounts created with an email code keep the address only as a
        # contact email.
        get_user_model().objects.filter(pk=self.organizer.pk).update(email="")
        self.client.post(f"/events/participants?code={self.event.code}", {}, format="json")

        own = next(item for item in self.roster()["participants"] if item["isOrganizer"])

        self.assertEqual(own["email"], ORGANIZER_EMAIL)
        search = self.client.get(f"/events/roster?code={self.event.code}&search=organizer@")
        self.assertEqual([row["name"] for row in search.data["participants"]], ["Olive Organizer"])

    def test_the_organizer_saves_their_own_schedule(self):
        self.client.post(f"/events/participants?code={self.event.code}", {}, format="json")
        own = Participant.objects.get(event=self.event, member=self.organizer)

        response = self.client.put(
            f"/events/participants/update?code={self.event.code}&participantId={self.organizer.pk}",
            {
                "availabilityInperson": [1, 0],
                "availabilityVirtual": [0, 0],
                "submitted": 1,
                "expectedVersion": own.version,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200, response.data)
        own.refresh_from_db()
        self.assertTrue(own.submitted)
        self.assertEqual(own.availability_inperson, [1, 0])


class GroupInclusionTests(RosterPeopleTestCase):
    def setUp(self):
        super().setUp()
        self.ada = self.add_person("Ada", "ada@example.com")
        self.bob = self.add_person("Bob", "bob@example.com")
        self.cy = self.add_person("Cy", "cy@example.com")
        self.dee = self.add_person("Dee", "dee@example.com")
        self.team1, self.team2 = ensure_groups(event=self.event, names=["Team 1", "Team 2"])
        self.ada.groups.add(self.team1)
        self.bob.groups.add(self.team1, self.team2)
        self.cy.groups.add(self.team2)
        Participant.objects.filter(pk=self.dee.pk).update(all_groups=True)

    def include_only(self, group_id, *, code=None):
        return self.client.post(
            f"/events/roster/groups/{group_id}/include-only?code={code or self.event.code}",
            {},
            format="json",
        )

    def included(self):
        return {row["name"]: row["included"] for row in self.roster()["participants"]}

    def test_including_only_one_group_leaves_everyone_else_out(self):
        Weight.objects.create(event=self.event, participant=self.cy, weight=0.4)
        revision = Event.objects.get(pk=self.event.pk).results_revision
        versions = {
            participant.pk: Participant.objects.get(pk=participant.pk).version
            for participant in (self.ada, self.bob, self.cy, self.dee)
        }

        response = self.include_only(self.team1.pk)

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["includedCount"], 3)
        self.assertEqual(response.data["updatedCount"], 1)
        self.assertEqual(response.data["resultsRevision"], revision + 1)
        self.assertEqual(self.included(), {"Ada": True, "Bob": True, "Cy": False, "Dee": True})
        # Weights are kept, so including Cy again restores the earlier results.
        self.assertEqual(Weight.objects.get(participant=self.cy).weight, 0.4)
        groups = {entry["name"]: entry for entry in response.data["groups"]}
        self.assertTrue(groups["Team 1"]["included"])
        self.assertIsNone(groups["Team 2"]["included"])
        self.assertEqual(Participant.objects.get(pk=self.cy.pk).version, versions[self.cy.pk] + 1)
        self.assertEqual(Participant.objects.get(pk=self.ada.pk).version, versions[self.ada.pk])

        switched = self.include_only(self.team2.pk)

        self.assertEqual(switched.data["updatedCount"], 2)
        self.assertEqual(self.included(), {"Ada": False, "Bob": True, "Cy": True, "Dee": True})

        again = self.include_only(self.team2.pk)

        self.assertEqual(again.data["updatedCount"], 0)
        self.assertEqual(again.data["resultsRevision"], switched.data["resultsRevision"])

    def test_people_without_a_group_are_left_out_too(self):
        loner = self.add_person("Loner", "loner@example.com")

        response = self.include_only(self.team2.pk)

        self.assertEqual(response.data["updatedCount"], 2)
        self.assertEqual(
            self.included(),
            {"Ada": False, "Bob": True, "Cy": True, "Dee": True, "Loner": False},
        )
        self.assertFalse(Weight.objects.get(participant=loner).included)

    def test_group_stats_report_the_shared_included_flag(self):
        self.client.patch(
            f"/events/roster/bulk?code={self.event.code}",
            {
                "participantIds": [str(self.cy.pk)],
                "updates": {"included": False},
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )
        empty = ParticipantGroup.objects.create(event=self.event, name="Team 3")

        groups = {entry["name"]: entry for entry in self.roster()["stats"]["groups"]}

        self.assertTrue(groups["Team 1"]["included"])
        self.assertIsNone(groups["Team 2"]["included"])
        # Only Dee (every group) counts in the new group.
        self.assertEqual(groups[empty.name]["count"], 1)
        self.assertTrue(groups[empty.name]["included"])

    def test_include_only_guards(self):
        self.assertEqual(self.include_only(999999).status_code, 404)
        self.assertEqual(self.include_only(self.team1.pk, code="MISSING1").status_code, 404)

        outsider = create_member("outsider@example.com", "Out", "Sider")
        self.authenticate(outsider)
        self.assertEqual(self.include_only(self.team1.pk).status_code, 403)

        self.authenticate(self.organizer)
        Event.objects.filter(pk=self.event.pk).update(status=Event.Status.CLOSED)
        self.assertEqual(self.include_only(self.team1.pk).status_code, 409)
        self.assertFalse(Weight.objects.filter(event=self.event).exists())


class RosterImportHeaderTests(TestCase):
    def test_plural_headers_map_to_their_field(self):
        self.assertEqual(
            auto_mapping(["Names", "Emails", "Groups", "Phones", "Weights"]),
            {"name": 0, "email": 1, "group": 2, "phone": 3, "weight": 4},
        )
        self.assertEqual(auto_mapping(["Name", "Email", "Teams"])["group"], 2)
        self.assertEqual(auto_mapping(["Name", "Email", "Team names"])["group"], 2)
        # A plural of something that is not an alias stays unmapped.
        self.assertEqual(auto_mapping(["Name", "Email", "Status"]), {"name": 0, "email": 1})
