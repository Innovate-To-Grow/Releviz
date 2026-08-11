from django.core.management.base import BaseCommand, CommandError

from apps.authn.services.members.sheet_sync import MemberSyncError, sync_members_to_sheet


class Command(BaseCommand):
    help = "Sync all members to the configured Google Sheet"

    def handle(self, *args, **options):
        self.stdout.write("Syncing members to Google Sheet...")
        try:
            rows = sync_members_to_sheet(sync_type="scheduled")
        except MemberSyncError as exc:
            # Raise CommandError so scheduled jobs exit non-zero on failure.
            # A silent stderr message with exit 0 makes monitoring/retry think
            # the sync succeeded when it didn't.
            raise CommandError(f"Sync failed: {exc}") from exc

        self.stdout.write(self.style.SUCCESS(f"Synced {rows} members to sheet."))
