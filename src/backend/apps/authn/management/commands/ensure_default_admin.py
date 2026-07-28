import os

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.authn.models import ContactEmail
from apps.authn.services import normalize_email


def validate_admin_password(password, *, member):
    meets_bootstrap_policy = (
        len(password) >= 32
        and any(character.islower() for character in password)
        and any(character.isupper() for character in password)
        and any(character.isdigit() for character in password)
        and any(not character.isalnum() and not character.isspace() for character in password)
    )
    if not meets_bootstrap_policy:
        raise CommandError(
            "The administrator password must be at least 32 characters and include "
            "lowercase, uppercase, numeric, and special characters."
        )

    try:
        validate_password(password, user=member)
    except ValidationError:
        raise CommandError(
            "The administrator password was rejected by the configured password validators."
        ) from None


def is_bootstrap_ready_admin(member, contact):
    return all(
        (
            member.is_active,
            member.is_staff,
            member.is_superuser,
            member.has_usable_password(),
            contact.email_type == "primary",
            contact.verified,
        )
    )


class Command(BaseCommand):
    help = "Create or update a default admin account identified by email."

    def add_arguments(self, parser):
        parser.add_argument("--yes", action="store_true")
        parser.add_argument(
            "--create-only",
            action="store_true",
            help="Create a missing admin, but never modify an existing account.",
        )
        parser.add_argument("--email", default=os.environ.get("DJANGO_SUPERUSER_EMAIL", ""))
        parser.add_argument("--password-env", default="DJANGO_SUPERUSER_PASSWORD")
        parser.add_argument(
            "--first-name", default=os.environ.get("DJANGO_SUPERUSER_FIRST_NAME", "Demo")
        )
        parser.add_argument(
            "--last-name", default=os.environ.get("DJANGO_SUPERUSER_LAST_NAME", "Admin")
        )

    def handle(self, *args, **options):
        if not options["yes"]:
            raise CommandError("Refusing to mutate admin users without --yes.")

        email = normalize_email(options["email"])
        password = os.environ.get(options["password_env"], "")
        if not email:
            raise CommandError("--email or DJANGO_SUPERUSER_EMAIL is required.")
        if not password:
            raise CommandError("The administrator password environment variable must be set.")

        Member = get_user_model()
        candidate = Member(
            email=email,
            first_name=options["first_name"],
            last_name=options["last_name"],
            is_active=True,
            is_staff=True,
            is_superuser=True,
        )
        validate_admin_password(password, member=candidate)

        with transaction.atomic():
            contacts = list(
                ContactEmail.objects.select_for_update()
                .select_related("member")
                .filter(email_address__iexact=email)
                .order_by("pk")[:2]
            )
            if len(contacts) > 1:
                raise CommandError(
                    "The default administrator identity matches multiple contact records; "
                    "refusing to choose one."
                )
            contact = contacts[0] if contacts else None
            member = contact.member if contact else None
            if options["create_only"]:
                conflicting_member = (
                    Member.objects.select_for_update()
                    .filter(email__iexact=email)
                    .exclude(pk=member.pk if member is not None else None)
                    .first()
                )
                if contact is not None and member is None:
                    raise CommandError(
                        "The default administrator identity already exists without an "
                        "owner; refusing to claim it in --create-only mode."
                    )
                if conflicting_member is not None:
                    raise CommandError(
                        "The default administrator identity conflicts with an existing "
                        "account; refusing to create or modify it."
                    )
                if member is not None and not is_bootstrap_ready_admin(member, contact):
                    raise CommandError(
                        "The existing default administrator is not bootstrap-ready; "
                        "refusing to modify it in --create-only mode."
                    )
                if member is not None:
                    self.stdout.write(
                        self.style.SUCCESS(
                            f"Default admin verified: email={email}, member={member.pk}"
                        )
                    )
                    return

            created = member is None
            if member is None:
                member = Member.objects.create_user(
                    password=password,
                    email=email,
                    first_name=options["first_name"],
                    last_name=options["last_name"],
                    is_active=True,
                    is_staff=True,
                    is_superuser=True,
                )
            else:
                member.email = email
                member.first_name = options["first_name"]
                member.last_name = options["last_name"]
                member.is_active = True
                member.is_staff = True
                member.is_superuser = True
                member.set_password(password)
                member.save()

            if contact is None:
                ContactEmail.objects.create(
                    member=member,
                    email_address=email,
                    email_type="primary",
                    verified=True,
                    subscribe=True,
                )
            else:
                contact.member = member
                contact.email_address = email
                contact.email_type = "primary"
                contact.verified = True
                contact.subscribe = True
                contact.save()

        action = "created" if created else "updated"
        self.stdout.write(
            self.style.SUCCESS(f"Default admin {action}: email={email}, member={member.pk}")
        )
