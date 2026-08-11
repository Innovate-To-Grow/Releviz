"""Seed deterministic records for browser-driven Django admin E2E tests."""

import os
from datetime import date

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.authn.models import ContactEmail
from apps.event.models import Event, Question, Ticket
from apps.projects.models import Project, Semester

DEFAULT_EMAIL = "admin-e2e@example.com"
DEFAULT_PASSWORD = "admin-e2e-password"
DEFAULT_NONSTAFF_EMAIL = "admin-e2e-nonstaff@example.com"
DEFAULT_ACTION_EMAIL = "action-e2e@example.com"
DEFAULT_FIRST_NAME = "Admin"
DEFAULT_LAST_NAME = "E2E"
DEFAULT_EVENT_NAME = "E2E Event Copy Template"


class Command(BaseCommand):
    help = "Create deterministic admin E2E credentials and sample admin data."

    def add_arguments(self, parser):
        parser.add_argument("--yes", action="store_true", help="Confirm that this mutating E2E seed may run.")
        parser.add_argument("--email", default=os.environ.get("ADMIN_E2E_EMAIL", DEFAULT_EMAIL))
        parser.add_argument("--password", default=os.environ.get("ADMIN_E2E_PASSWORD", DEFAULT_PASSWORD))
        parser.add_argument(
            "--nonstaff-email",
            default=os.environ.get("ADMIN_E2E_NONSTAFF_EMAIL", DEFAULT_NONSTAFF_EMAIL),
        )
        parser.add_argument("--action-email", default=os.environ.get("ADMIN_E2E_ACTION_EMAIL", DEFAULT_ACTION_EMAIL))
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
            raise CommandError("--email, --password, --nonstaff-email, and --action-email are required.")

        with transaction.atomic():
            member = self._upsert_admin_member(email, password, first_name, last_name)
            self._upsert_nonstaff_member(nonstaff_email, password)
            self._upsert_action_contact_email(action_email)
            semester = self._upsert_sample_semester()
            project = self._upsert_sample_project(semester)
            event = self._upsert_sample_event()

        self.stdout.write(
            self.style.SUCCESS(
                "Seeded admin E2E data: "
                f"email={email}, member={member.pk}, semester={semester.label}, "
                f"project={project.project_title}, event={event.name}"
            )
        )

    def _upsert_admin_member(self, email, password, first_name, last_name):
        Member = get_user_model()
        contact = ContactEmail.objects.select_related("member").filter(email_address__iexact=email).first()
        member = contact.member if contact else None
        candidate = member or Member(first_name=first_name, last_name=last_name)
        try:
            validate_password(password, user=candidate)
        except ValidationError as exc:
            raise CommandError(f"Refusing weak E2E admin password: {'; '.join(exc.messages)}") from exc

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
            member.save(update_fields=["first_name", "last_name", "is_active", "is_staff", "is_superuser", "password"])

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
        contact = ContactEmail.objects.select_related("member").filter(email_address__iexact=email).first()
        member = contact.member if contact else None
        candidate = member or Member(first_name="Nonstaff", last_name="E2E")
        try:
            validate_password(password, user=candidate)
        except ValidationError as exc:
            raise CommandError(f"Refusing weak E2E nonstaff password: {'; '.join(exc.messages)}") from exc

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
            member.save(update_fields=["first_name", "last_name", "is_active", "is_staff", "is_superuser", "password"])

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

    def _upsert_sample_semester(self):
        semester, _ = Semester.objects.update_or_create(
            year=2099,
            season=Semester.Season.FALL,
            defaults={"is_published": False},
        )
        return semester

    def _upsert_sample_project(self, semester):
        project, _ = Project.objects.update_or_create(
            semester=semester,
            team_number="E2E-1",
            defaults={
                "class_code": "E2E",
                "team_name": "Admin Browser Team",
                "project_title": "E2E Solar Orchard Dashboard",
                "organization": "Innovate To Grow QA",
                "industry": "Testing",
                "abstract": "Seed project used by browser-driven Django admin tests.",
                "student_names": "Ada Lovelace; Grace Hopper",
                "track": 1,
                "presentation_order": 1,
            },
        )
        return project

    def _upsert_sample_event(self):
        event, _ = Event.objects.update_or_create(
            slug="e2e-event-copy-template",
            defaults={
                "name": DEFAULT_EVENT_NAME,
                "date": date(2099, 5, 14),
                "end_date": date(2099, 5, 16),
                "location": "E2E Event Hall",
                "description": "Seed Event used to verify the safe Add Event copy flow.",
                "registration_open": False,
                "allow_secondary_email": True,
                "collect_phone": True,
                "verify_phone": True,
                "ticket_login_validity_days": 45,
                "ticket_login_reusable": False,
            },
        )
        ticket_templates = {
            "E2E General Admission": {"order": 1},
            "E2E VIP Admission": {"order": 2},
        }
        event.tickets.exclude(name__in=ticket_templates).delete()
        for name, defaults in ticket_templates.items():
            Ticket.objects.update_or_create(event=event, name=name, defaults=defaults)

        question_templates = {
            "What brings you to the E2E Event?": {"is_required": True, "order": 1},
            "Do you need accessibility accommodations?": {"is_required": False, "order": 2},
        }
        event.questions.exclude(text__in=question_templates).delete()
        for text, defaults in question_templates.items():
            Question.objects.update_or_create(event=event, text=text, defaults=defaults)
        return event
