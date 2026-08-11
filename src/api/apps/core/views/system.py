"""System-level public views: robots.txt, landing page, error handlers."""

from django.http import HttpResponse
from django.shortcuts import render


def robots_txt(request):
    """Serve robots.txt for search engine crawlers."""
    lines = [
        "User-agent: *",
        "Disallow: /",
        "",
    ]
    return HttpResponse("\n".join(lines), content_type="text/plain")


def root_index(request):
    """Static landing page"""

    return render(request, "index.html", status=200)


# noinspection PyUnusedLocal
def custom_404(request, exception):
    """Custom 404 page using the admin theme."""
    return render(request, "404.html", status=404)
