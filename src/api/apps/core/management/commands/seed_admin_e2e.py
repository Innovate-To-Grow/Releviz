"""Seed deterministic records for browser-driven Django admin E2E tests."""

import os

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.authn.models import ContactEmail
from apps.scheduling.models import Event, Participant, UserEvent, Weight

DEFAULT_EMAIL = "admin-e2e@example.com"
DEFAULT_PASSWORD = "admin-e2e-password"
DEFAULT_NONSTAFF_EMAIL = "admin-e2e-nonstaff@example.com"
DEFAULT_ACTION_EMAIL = "action-e2e@example.com"
DEFAULT_FIRST_NAME = "Admin"
DEFAULT_LAST_NAME = "E2E"
DEFAULT_EVENT_CODE = "E2EADMIN"
DEFAULT_EVENT_NAME = "E2E Design Review"


class Command(BaseCommand):
    help = "Create deterministic admin E2E credentials and sample admin data."

    def add_arguments(self, parser):
        parser.add_argument(
            "--yes", action="store_true", help="Confirm that this mutating E2E seed may run."
        )
        parser.add_argument("--email", default=os.environ.get("ADMIN_E2E_EMAIL", DEFAULT_EMAIL))
        parser.add_argument(
            "--password", default=os.environ.get("ADMIN_E2E_PASSWORD", DEFAULT_PASSWORD)
        )
        parser.add_argument(
            "--nonstaff-email",
            default=os.environ.get("ADMIN_E2E_NONSTAFF_EMAIL", DEFAULT_NONSTAFF_EMAIL),
        )
        parser.add_argument(
            "--action-email", default=os.environ.get("ADMIN_E2E_ACTION_EMAIL", DEFAULT_ACTION_EMAIL)
        )
        parser.add_argument("--first-name", default=DEFAULT_FIRST_NAME)
        parser.add_argument("--last-name", default=DEFAULT_LAST_NAME)

    def handle(self, *args, **options):
        if not options["yes"]:
            raise CommandError("Refusing to mutate the database without --yes.")

        settings_module = os.environ.get("DJANGO_SETTINGS_MODULE", "")
        if settings_module.endswith(".production"):
            raise CommandError("Refusing to seed admin E2E data with production settings.")

        email = options["email"].strip().lower()
        password = options["password"]
        nonstaff_email = options["nonstaff_email"].strip().lower()
        action_email = options["action_email"].strip().lower()
        first_name = options["first_name"].strip() or DEFAULT_FIRST_NAME
        last_name = options["last_name"].strip() or DEFAULT_LAST_NAME

        if not email or not password or not nonstaff_email or not action_email:
            raise CommandError(
                "--email, --password, --nonstaff-email, and --action-email are required."
            )

        with transaction.atomic():
            member = self._upsert_admin_member(email, password, first_name, last_name)
            nonstaff_member = self._upsert_nonstaff_member(nonstaff_email, password)
            self._upsert_action_contact_email(action_email)
            event = self._reset_sample_event(member)
            self._upsert_sample_participant(event, nonstaff_member)

        self.stdout.write(
            self.style.SUCCESS(
                "Seeded admin E2E data: "
                f"email={email}, member={member.pk}, event={event.name} ({event.code})"
            )
        )

    def _upsert_admin_member(self, email, password, first_name, last_name):
        Member = get_user_model()
        contact = (
            ContactEmail.objects.select_related("member")
            .filter(email_address__iexact=email)
            .first()
        )
        member = contact.member if contact else None
        candidate = member or Member(first_name=first_name, last_name=last_name)
        try:
            validate_password(password, user=candidate)
        except ValidationError as exc:
            raise CommandError(
                f"Refusing weak E2E admin password: {'; '.join(exc.messages)}"
            ) from exc

        if member is None:
            member = Member.objects.create_user(
                password=password,
                first_name=first_name,
                last_name=last_name,
                is_active=True,
                is_staff=True,
                is_superuser=True,
            )
        else:
            member.first_name = first_name
            member.last_name = last_name
            member.is_active = True
            member.is_staff = True
            member.is_superuser = True
            member.set_password(password)
            member.save(
                update_fields=[
                    "first_name",
                    "last_name",
                    "is_active",
                    "is_staff",
                    "is_superuser",
                    "password",
                ]
            )

        ContactEmail.objects.update_or_create(
            email_address=email,
            defaults={
                "member": member,
                "email_type": "primary",
                "verified": True,
                "subscribe": True,
            },
        )
        return member

    def _upsert_nonstaff_member(self, email, password):
        Member = get_user_model()
        contact = (
            ContactEmail.objects.select_related("member")
            .filter(email_address__iexact=email)
            .first()
        )
        member = contact.member if contact else None
        candidate = member or Member(first_name="Nonstaff", last_name="E2E")
        try:
            validate_password(password, user=candidate)
        except ValidationError as exc:
            raise CommandError(
                f"Refusing weak E2E nonstaff password: {'; '.join(exc.messages)}"
            ) from exc

        if member is None:
            member = Member.objects.create_user(
                password=password,
                first_name="Nonstaff",
                last_name="E2E",
                is_active=True,
                is_staff=False,
                is_superuser=False,
            )
        else:
            member.first_name = "Nonstaff"
            member.last_name = "E2E"
            member.is_active = True
            member.is_staff = False
            member.is_superuser = False
            member.set_password(password)
            member.save(
                update_fields=[
                    "first_name",
                    "last_name",
                    "is_active",
                    "is_staff",
                    "is_superuser",
                    "password",
                ]
            )

        ContactEmail.objects.update_or_create(
            email_address=email,
            defaults={
                "member": member,
                "email_type": "primary",
                "verified": True,
                "subscribe": True,
            },
        )
        return member

    def _upsert_action_contact_email(self, email):
        contact, _ = ContactEmail.objects.update_or_create(
            email_address=email,
            defaults={
                "member": None,
                "email_type": "other",
                "verified": False,
                "subscribe": True,
            },
        )
        return contact

    def _reset_sample_event(self, organizer):
        # The reserved event may have been edited, finalized, or seeded with
        # different identities during a previous browser run. Recreating it
        # gives every E2E run the same complete relation graph; cascading
        # deletes remove stale participants, memberships, results, and meetings.
        Event.objects.filter(code=DEFAULT_EVENT_CODE).delete()
        event = Event.objects.create(
            code=DEFAULT_EVENT_CODE,
            name=DEFAULT_EVENT_NAME,
            organizer=organizer,
            start_minutes=9 * 60,
            end_minutes=17 * 60,
            slot_minutes=30,
            days=[1, 2, 3, 4, 5],
            mode="mixed",
            location="Design Studio",
            participant_view_permission="realtime",
            day_selection_type="days_of_week",
            specific_dates=None,
            timezone="UTC",
            reminders_enabled=False,
            access_mode="open_link",
            meeting_duration_minutes=60,
            status=Event.Status.ACTIVE,
        )
        UserEvent.objects.update_or_create(
            member=organizer,
            event=event,
            role="organizer",
        )
        return event

    def _upsert_sample_participant(self, event, member):
        availability = [1 if index % 3 else 0 for index in range(80)]
        participant, _ = Participant.objects.update_or_create(
            event=event,
            member=member,
            defaults={
                "participant_name": "Nonstaff E2E",
                "availability_inperson": availability,
                "availability_virtual": list(reversed(availability)),
                "submitted": True,
                "group_name": "Design Review",
                "sort_order": 1,
            },
        )
        UserEvent.objects.update_or_create(
            member=member,
            event=event,
            role="participant",
        )
        Weight.objects.update_or_create(
            event=event,
            participant=participant,
            defaults={"weight": 0.75, "included": True},
        )
        return participant
