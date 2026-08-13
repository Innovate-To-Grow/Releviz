from urllib.parse import urlencode

from django.conf import settings

from apps.mail.email_templates import render_branded_email

from .config import (
    PUBLIC_LINK_DESCRIPTIONS,
    PUBLIC_LINK_LABELS,
    PURPOSE_DISPLAY,
    PURPOSE_TITLES,
)


def build_email_action(
    *,
    recipient: str,
    code: str,
    purpose: str,
    link_flow: str | None,
    link_source: str | None,
    link_event: str | None = None,
    link_next: str | None = None,
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
            **({"next": link_next} if link_next else {}),
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
    link_next: str | None = None,
) -> str:
    action = build_email_action(
        recipient=recipient,
        code=code,
        purpose=purpose,
        link_flow=link_flow,
        link_source=link_source,
        link_event=link_event,
        link_next=link_next,
    )
    purpose_display = PURPOSE_DISPLAY.get(purpose, "complete your request")
    paragraphs = [
        f"Use the one-time code below to {purpose_display}.",
        "This code expires in 10 minutes.",
    ]
    if action["description"]:
        paragraphs.append(action["description"])

    return render_branded_email(
        title=PURPOSE_TITLES.get(purpose, "Your verification code"),
        preheader=f"Use this one-time code to {purpose_display}.",
        eyebrow="Releviz security",
        paragraphs=paragraphs,
        code=code,
        cta_label=action["label"],
        cta_url=action["url"],
        notice="If you did not request this code, you can safely ignore this email.",
    )
