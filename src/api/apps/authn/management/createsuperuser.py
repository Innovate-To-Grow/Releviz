"""
Custom createsuperuser command that prompts for email and creates a ContactEmail record.

Since Member has no username field (UUID is the primary key), this command
prompts for email + password and creates the superuser with a ContactEmail.
"""

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from apps.authn.models import ContactEmail


class Command(BaseCommand):
    help = "Create a superuser with an email address and ContactEmail record."

    def add_arguments(self, parser):
        parser.add_argument("--email", type=str, help="Email address for the superuser.")
        parser.add_argument("--password", type=str, help="Password for the superuser.")
        parser.add_argument("--first-name", type=str, default="", help="First name.")
        parser.add_argument("--last-name", type=str, default="", help="Last name.")
        parser.add_argument(
            "--noinput",
            "--no-input",
            action="store_false",
            dest="interactive",
            help="Non-interactive mode.",
        )

    def handle(self, *args, **options):
        Member = get_user_model()
        interactive = options.get("interactive", True)
        email = options.get("email")
        password = options.get("password")
        first_name = options.get("first_name") or ""
        last_name = options.get("last_name") or ""

        if interactive:
            while not email:
                email = input("Email address: ").strip()
                if not email:
                    self.stderr.write("Error: Email address cannot be blank.")
                    email = None
                    continue
                if ContactEmail.objects.filter(email_address__iexact=email).exists():
                    self.stderr.write(f"Error: A contact email with address '{email}' already exists.")
                    email = None

            while not password:
                import getpass

                password = getpass.getpass("Password: ")
                password2 = getpass.getpass("Password (again): ")
                if password != password2:
                    self.stderr.write("Error: Passwords do not match.")
                    password = None

            while not first_name.strip():
                first_name = input("First name: ").strip()
                if not first_name:
                    self.stderr.write("Error: First name cannot be blank.")

            while not last_name.strip():
                last_name = input("Last name: ").strip()
                if not last_name:
                    self.stderr.write("Error: Last name cannot be blank.")
        else:
            if not email or not password or not first_name.strip() or not last_name.strip():
                raise CommandError(
                    "--email, --password, --first-name, and --last-name are required in non-interactive mode."
                )
            if ContactEmail.objects.filter(email_address__iexact=email).exists():
                raise CommandError(f"A contact email with address '{email}' already exists.")

        member = Member.objects.create_superuser(
            password=password,
            first_name=first_name.strip(),
            last_name=last_name.strip(),
        )

        ContactEmail.objects.create(
            member=member,
            email_address=email,
            email_type="primary",
            verified=True,
            subscribe=True,
        )

        self.stdout.write(self.style.SUCCESS(f"Superuser created with email '{email}' (UUID: {member.id})."))
