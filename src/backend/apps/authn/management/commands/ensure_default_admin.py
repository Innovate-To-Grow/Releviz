import os

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.authn.models import ContactEmail
from apps.authn.services import normalize_email


class Command(BaseCommand):
    help = "Create or update a default admin account identified by email."

    def add_arguments(self, parser):
        parser.add_argument("--yes", action="store_true")
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
            raise CommandError(f"{options['password_env']} must be set.")

        Member = get_user_model()
        with transaction.atomic():
            contact = (
                ContactEmail.objects.select_related("member")
                .filter(email_address__iexact=email)
                .first()
            )
            member = contact.member if contact else None
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
