from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from apps.authn.security import prune_auth_security_state
from apps.core.retention import prune_feedback_submissions
from apps.messaging.services import dispatch_due_email_jobs
from apps.scheduling.services import send_due_event_reminders


class Command(BaseCommand):
    help = "Send due event invitation reminders."

    def add_arguments(self, parser):
        parser.add_argument("--window-minutes", type=int, default=20)

    def handle(self, *args, **options):
        window_minutes = options["window_minutes"]
        if window_minutes < 1:
            raise CommandError("window-minutes must be positive")
        queued = send_due_event_reminders(window_minutes=window_minutes)
        self.stdout.write(f"Queued {queued} new reminder email job(s).")
        delivery = dispatch_due_email_jobs(limit=100)
        self.stdout.write(
            "Email jobs: "
            f"attempted={delivery['attempted']} "
            f"sent={delivery['sent']} "
            f"retry={delivery['retry']} "
            f"permanent_failure={delivery['permanentFailure']} "
            f"canceled={delivery['canceled']}."
        )
        pruned = prune_auth_security_state()
        self.stdout.write(
            "Auth security cleanup: "
            f"rate_limit_buckets={pruned['rateLimitBuckets']} "
            f"sessions={pruned['sessions']} "
            f"temporary_event_sessions={pruned['temporaryEventSessions']} "
            f"outstanding_tokens={pruned['outstandingTokens']} "
            f"auth_challenges={pruned['authChallenges']} "
            f"auth_email_jobs={pruned['authEmailJobs']}."
        )
        deleted_feedback = prune_feedback_submissions(as_of=timezone.now())
        self.stdout.write(f"Feedback cleanup: deleted={deleted_feedback}.")
