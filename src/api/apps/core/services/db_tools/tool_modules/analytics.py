import json

from django.db.models import Count

from .helpers import _truncate


def get_page_views(params):
    from apps.cms.models import PageView

    qs = PageView.objects.all()
    if params.get("path"):
        qs = qs.filter(path__icontains=params["path"])
    if params.get("date_from"):
        qs = qs.filter(timestamp__gte=params["date_from"])
    if params.get("date_to"):
        qs = qs.filter(timestamp__lte=params["date_to"])
    if params.get("count_only"):
        return f"Page view count: {qs.count()}"
    from django.db.models.functions import TruncDate

    by_date = qs.annotate(day=TruncDate("timestamp")).values("day").annotate(views=Count("id")).order_by("-day")[:30]
    top_pages = qs.values("path").annotate(views=Count("id")).order_by("-views")[:20]
    return _truncate(
        f"Total views: {qs.count()}\n\n"
        f"Views by date (last 30 days):\n{json.dumps(list(by_date), default=str)}\n\n"
        f"Top pages:\n{json.dumps(list(top_pages), default=str)}"
    )
