"""Create a default Django admin account without silently promoting existing users."""

import os

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.authn.models import ContactEmail

DEFAULT_FIRST_NAME = "Demo"
DEFAULT_LAST_NAME = "Admin"


class _ConcurrentAdminCreated(Exception):
    """A competing command claimed the configured email first."""


class Command(BaseCommand):
    help = "Create a default superuser identified by email if it does not already exist."

    def add_arguments(self, parser):
        parser.add_argument("--yes", action="store_true", help="Confirm that this command may mutate admin users.")
        parser.add_argument("--email", default=os.environ.get("DJANGO_SUPERUSER_EMAIL", ""))
        parser.add_argument("--password-env", default="DJANGO_SUPERUSER_PASSWORD")
        parser.add_argument(
            "--first-name",
            default=os.environ.get("DJANGO_SUPERUSER_FIRST_NAME", DEFAULT_FIRST_NAME),
        )
        parser.add_argument(
            "--last-name",
            default=os.environ.get("DJANGO_SUPERUSER_LAST_NAME", DEFAULT_LAST_NAME),
        )

    def handle(self, *args, **options):
        if not options["yes"]:
            raise CommandError("Refusing to mutate admin users without --yes.")

        email = (options["email"] or "").strip().lower()
        password_env = (options["password_env"] or "").strip()
        first_name = (options["first_name"] or DEFAULT_FIRST_NAME).strip() or DEFAULT_FIRST_NAME
        last_name = (options["last_name"] or DEFAULT_LAST_NAME).strip() or DEFAULT_LAST_NAME

        if not email:
            raise CommandError("--email or DJANGO_SUPERUSER_EMAIL is required.")
        if not password_env:
            raise CommandError("--password-env is required.")

        try:
            with transaction.atomic():
                contact = self._find_contact_for_update(email)
                if contact is not None and contact.member_id is not None:
                    self._validate_existing_admin(email=email, contact=contact)
                    self._write_existing_admin(email=email, contact=contact)
                    return

                password = os.environ.get(password_env, "")
                if not password:
                    raise CommandError(f"{password_env} must be set.")

                member = self._create_member(
                    email=email,
                    password=password,
                    first_name=first_name,
                    last_name=last_name,
                    contact=contact,
                )
        except _ConcurrentAdminCreated:
            # Roll back the losing command's tentative Member before inspecting
            # the row committed by the winner.
            with transaction.atomic():
                contact = self._find_contact_for_update(email)
                if contact is None or contact.member_id is None:
                    raise CommandError(
                        f"Email {email} was claimed concurrently without a valid admin owner; refusing to continue."
                    ) from None
                self._validate_existing_admin(email=email, contact=contact)
                self._write_existing_admin(email=email, contact=contact)
            return

        self.stdout.write(self.style.SUCCESS(f"Default admin created: email={email}, member={member.pk}"))

    @staticmethod
    def _find_contact_for_update(email: str):
        # Joining the nullable member relation makes PostgreSQL reject FOR
        # UPDATE on the outer join, so lock the member separately below.
        return ContactEmail.objects.select_for_update().filter(email_address__iexact=email).first()

    def _validate_existing_admin(self, *, email: str, contact) -> None:
        Member = get_user_model()
        member = Member.objects.select_for_update().get(pk=contact.member_id)
        if not (member.is_active and member.is_staff and member.is_superuser):
            raise CommandError(
                f"Email {email} belongs to a member who is not an active staff superuser; "
                "refusing to promote or replace that account."
            )
        if not contact.verified:
            raise CommandError(
                f"Email {email} belongs to an active staff superuser, but the contact is not verified; "
                "refusing to verify or otherwise modify that account."
            )

    def _write_existing_admin(self, *, email: str, contact) -> None:
        self.stdout.write(
            self.style.WARNING(
                f"Default admin already exists; left unchanged: email={email}, member={contact.member_id}"
            )
        )

    def _create_member(self, *, email: str, password: str, first_name: str, last_name: str, contact=None):
        Member = get_user_model()
        member = Member.objects.create_user(
            password=password,
            first_name=first_name,
            last_name=last_name,
            is_active=True,
            is_staff=True,
            is_superuser=True,
        )
        if contact is None:
            _contact, created = ContactEmail.objects.get_or_create(
                email_address=email,
                defaults={
                    "member": member,
                    "email_type": "primary",
                    "verified": True,
                    "subscribe": True,
                },
            )
            if not created:
                raise _ConcurrentAdminCreated
        else:
            contact.member = member
            contact.email_type = "primary"
            contact.verified = True
            contact.save(update_fields=["member", "email_type", "verified", "updated_at"])
        return member
