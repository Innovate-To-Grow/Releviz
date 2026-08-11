"""System-level public views: robots.txt, sitemap, landing page, error handlers."""

from datetime import UTC
from html import escape
from urllib.parse import quote

from django.conf import settings
from django.db.models import Max
from django.http import HttpResponse
from django.shortcuts import render
from django.utils import timezone

from apps.cms.models import CMSPage

SITEMAP_XMLNS = "http://www.sitemaps.org/schemas/sitemap/0.9"


def robots_txt(request):
    """Serve robots.txt for search engine crawlers."""
    lines = [
        "User-agent: *",
        "Disallow: /",
        "",
    ]
    return HttpResponse("\n".join(lines), content_type="text/plain")


def _canonical_frontend_base(request):
    base = (getattr(settings, "FRONTEND_URL", "") or "").strip().rstrip("/")
    if base:
        return base
    return request.build_absolute_uri("/").rstrip("/")


def _sitemap_url(base, route):
    if route == "/":
        return f"{base}/"
    quoted_path = quote(route, safe="/")
    return f"{base}{quoted_path}"


def _sitemap_lastmod(page):
    candidates = [page.updated_at, page.published_at, getattr(page, "latest_block_updated_at", None)]
    latest = max((value for value in candidates if value), default=None)
    if latest is None:
        return ""
    return timezone.localtime(latest, timezone=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sitemap_xml(request):
    """Serve the public CMS-backed sitemap for the frontend domain."""
    base = _canonical_frontend_base(request)
    pages = (
        CMSPage.objects.filter(status="published")
        .annotate(latest_block_updated_at=Max("blocks__updated_at"))
        .order_by("route")
    )

    lines = ['<?xml version="1.0" encoding="UTF-8"?>', f'<urlset xmlns="{SITEMAP_XMLNS}">']
    for page in pages:
        lines.append("  <url>")
        lines.append(f"    <loc>{escape(_sitemap_url(base, page.route))}</loc>")
        lastmod = _sitemap_lastmod(page)
        if lastmod:
            lines.append(f"    <lastmod>{lastmod}</lastmod>")
        lines.append("  </url>")
    lines.append("</urlset>")
    return HttpResponse("\n".join(lines), content_type="application/xml")


def root_index(request):
    """Static landing page"""

    return render(request, "index.html", status=200)


# noinspection PyUnusedLocal
def custom_404(request, exception):
    """Custom 404 page using the admin theme."""
    return render(request, "404.html", status=404)
