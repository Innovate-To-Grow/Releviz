from django.core.management.base import BaseCommand, CommandError

from apps.scheduling.services import send_due_event_reminders


class Command(BaseCommand):
    help = "Send due event invitation reminders."

    def add_arguments(self, parser):
        parser.add_argument("--window-minutes", type=int, default=20)

    def handle(self, *args, **options):
        window_minutes = options["window_minutes"]
        if window_minutes < 1:
            raise CommandError("window-minutes must be positive")
        sent = send_due_event_reminders(window_minutes=window_minutes)
        self.stdout.write(f"Sent {sent} reminder email(s).")
