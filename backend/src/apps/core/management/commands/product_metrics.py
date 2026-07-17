import json

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.core.analytics import build_product_metrics


class Command(BaseCommand):
    help = "Emit privacy-bounded product metrics as JSON."

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=30)
        parser.add_argument("--as-of", default="")

    def handle(self, *args, **options):
        days = options["days"]
        if days < 1:
            raise CommandError("--days must be at least 1.")
        as_of_value = options["as_of"]
        as_of = timezone.now()
        if as_of_value:
            as_of = parse_datetime(as_of_value)
            if as_of is None or timezone.is_naive(as_of):
                raise CommandError("--as-of must be an ISO timestamp with a UTC offset.")
        metrics = build_product_metrics(as_of=as_of, window_days=days)
        self.stdout.write(json.dumps(metrics, sort_keys=True))
