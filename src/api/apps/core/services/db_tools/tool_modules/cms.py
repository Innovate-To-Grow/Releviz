from .helpers import _serialize_rows


def search_cms_pages(params):
    from apps.cms.models import CMSPage

    qs = CMSPage.objects.all()
    if params.get("title"):
        qs = qs.filter(title__icontains=params["title"])
    if params.get("slug"):
        qs = qs.filter(slug__icontains=params["slug"])
    if params.get("status"):
        qs = qs.filter(status=params["status"])
    return _serialize_rows(
        qs.order_by("sort_order"),
        [
            "id",
            "title",
            "slug",
            "route",
            "status",
            "meta_description",
            "published_at",
        ],
    )


def search_news(params):
    from apps.cms.models import NewsArticle

    qs = NewsArticle.objects.all()
    if params.get("title"):
        qs = qs.filter(title__icontains=params["title"])
    if params.get("source"):
        qs = qs.filter(source__icontains=params["source"])
    if params.get("date_from"):
        qs = qs.filter(published_at__gte=params["date_from"])
    if params.get("date_to"):
        qs = qs.filter(published_at__lte=params["date_to"])
    return _serialize_rows(
        qs.order_by("-published_at"),
        [
            "id",
            "title",
            "source",
            "author",
            "source_url",
            "published_at",
            "summary",
        ],
    )
