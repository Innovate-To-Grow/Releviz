from urllib.parse import urlencode

from django.conf import settings
from django.template.loader import render_to_string

from .config import PUBLIC_LINK_DESCRIPTIONS, PUBLIC_LINK_LABELS, PURPOSE_DISPLAY


def build_email_action(
    *,
    recipient: str,
    code: str,
    purpose: str,
    link_flow: str | None,
    link_source: str | None,
    link_event: str | None = None,
):
    frontend_url = (getattr(settings, "FRONTEND_URL", "") or "").strip().rstrip("/")
    normalized_email = (recipient or "").strip().lower()
    if (
        purpose not in {"register", "login"}
        or link_flow not in {"auth", "login", "register"}
        or link_source not in PUBLIC_LINK_LABELS
        or not frontend_url
        or not normalized_email
    ):
        return {"url": "", "label": "", "description": ""}

    params = urlencode(
        {
            "flow": link_flow,
            "source": link_source,
            "email": normalized_email,
            "code": code,
            **({"event": link_event} if link_event else {}),
        }
    )
    return {
        "url": f"{frontend_url}/email-auth-link#{params}",
        "label": PUBLIC_LINK_LABELS[link_source],
        "description": PUBLIC_LINK_DESCRIPTIONS[link_source],
    }


def render_email_body(
    *,
    recipient: str,
    code: str,
    purpose: str,
    link_flow: str | None = None,
    link_source: str | None = None,
    link_event: str | None = None,
) -> str:
    action = build_email_action(
        recipient=recipient,
        code=code,
        purpose=purpose,
        link_flow=link_flow,
        link_source=link_source,
        link_event=link_event,
    )
    return render_to_string(
        "authn/email/verification_code.html",
        {
            "code": code,
            "purpose_display": PURPOSE_DISPLAY.get(purpose, "complete your request"),
            "expiry_minutes": 10,
            "action_url": action["url"],
            "action_label": action["label"],
            "action_description": action["description"],
        },
    )
