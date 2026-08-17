from django.core.management.base import BaseCommand

from apps.scheduling.services.roster_imports import expire_stale_roster_imports


class Command(BaseCommand):
    help = "Delete expired roster preview rows and scrub their temporary metadata."

    def handle(self, *args, **options):
        expired = expire_stale_roster_imports()
        self.stdout.write(self.style.SUCCESS(f"Expired {expired} roster import preview(s)."))
