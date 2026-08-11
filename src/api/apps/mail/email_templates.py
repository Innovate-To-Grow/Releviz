from __future__ import annotations

from collections.abc import Sequence

from django.conf import settings
from django.template.loader import render_to_string


def brand_site_url() -> str:
    return (
        getattr(settings, "FRONTEND_URL", "")
        or getattr(settings, "BACKEND_URL", "")
        or "https://releviz.com"
    ).rstrip("/")


def render_branded_email(
    *,
    title: str,
    preheader: str = "",
    eyebrow: str = "Releviz",
    greeting: str = "",
    paragraphs: Sequence[str] = (),
    details: Sequence[tuple[str, str]] = (),
    code: str = "",
    cta_label: str = "",
    cta_url: str = "",
    notice: str = "",
) -> str:
    site_url = brand_site_url()
    return render_to_string(
        "mail/email/branded.html",
        {
            "title": title,
            "preheader": preheader or title,
            "eyebrow": eyebrow,
            "greeting": greeting,
            "paragraphs": list(paragraphs),
            "details": [
                {"label": str(label), "value": str(value)} for label, value in details if value
            ],
            "code": code,
            "cta_label": cta_label,
            "cta_url": cta_url,
            "notice": notice,
            "site_url": site_url,
            "logo_url": f"{site_url}/brand/releviz-logo.png",
            "support_url": f"{site_url}/support",
        },
    )
