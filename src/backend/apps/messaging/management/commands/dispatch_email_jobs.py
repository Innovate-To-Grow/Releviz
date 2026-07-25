from django.core.management.base import BaseCommand, CommandError

from apps.messaging.services import dispatch_due_email_jobs


class Command(BaseCommand):
    help = "Dispatch due durable email delivery jobs."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=100)

    def handle(self, *args, **options):
        limit = options["limit"]
        if limit < 1 or limit > 1000:
            raise CommandError("limit must be between 1 and 1000")
        summary = dispatch_due_email_jobs(limit=limit)
        self.stdout.write(
            "Email jobs: "
            f"attempted={summary['attempted']} "
            f"sent={summary['sent']} "
            f"retry={summary['retry']} "
            f"permanent_failure={summary['permanentFailure']} "
            f"canceled={summary['canceled']}."
        )
