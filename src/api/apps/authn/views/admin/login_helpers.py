"""Helpers for the admin login view."""

import uuid

from django.conf import settings
from django.contrib import admin
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.shortcuts import render
from django.utils.http import url_has_allowed_host_and_scheme

_SESSION_STEP = "admin_login_step"
_SESSION_EMAIL = "admin_login_email"
_SESSION_MEMBER_ID = "admin_login_member_id"
_SESSION_HIDE_EMAIL = "admin_login_hide_email"
_RATE_LIMIT_PREFIX = "admin_pwd_login:"
_MAX_PASSWORD_ATTEMPTS = 10
_RATE_LIMIT_WINDOW = 120
LAST_ADMIN_LOGIN_COOKIE_NAME = "i2g_last_admin_member"
LAST_ADMIN_LOGIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 30
_LAST_ADMIN_LOGIN_COOKIE_PATH = "/admin/"


def clear_admin_login_session(request):
    for key in (_SESSION_STEP, _SESSION_EMAIL, _SESSION_MEMBER_ID, _SESSION_HIDE_EMAIL):
        request.session.pop(key, None)


def get_admin_login_state(request):
    return (
        request.session.get(_SESSION_STEP, "email"),
        request.session.get(_SESSION_EMAIL, ""),
        request.session.get(_SESSION_MEMBER_ID),
    )


def get_admin_login_member(request):
    member_id = request.session.get(_SESSION_MEMBER_ID)
    if not member_id:
        return None

    try:
        uuid.UUID(str(member_id))
    except (TypeError, ValueError):
        return None

    return get_user_model().objects.filter(pk=member_id, is_staff=True, is_active=True).first()


def set_admin_login_state(
    request,
    *,
    step: str,
    email: str,
    member_id: str | None = None,
    hide_email: bool = False,
) -> None:
    request.session[_SESSION_STEP] = step
    request.session[_SESSION_EMAIL] = email
    request.session[_SESSION_HIDE_EMAIL] = hide_email
    if member_id is not None:
        request.session[_SESSION_MEMBER_ID] = member_id


def safe_admin_next(request):
    next_url = request.GET.get("next") or request.POST.get("next", "")
    if next_url and url_has_allowed_host_and_scheme(next_url, allowed_hosts={request.get_host()}):
        return next_url
    return "/admin/"


def is_password_throttled(request):
    return cache.get(_password_rate_key(request), 0) >= _MAX_PASSWORD_ATTEMPTS


def record_password_failure(request):
    key = _password_rate_key(request)
    try:
        cache.incr(key)
    except ValueError:
        cache.set(key, 1, _RATE_LIMIT_WINDOW)


def clear_password_rate_limit(request):
    cache.delete(_password_rate_key(request))


def get_last_admin_login_member(request):
    member_id = request.get_signed_cookie(
        LAST_ADMIN_LOGIN_COOKIE_NAME,
        default=None,
        max_age=LAST_ADMIN_LOGIN_COOKIE_MAX_AGE,
    )
    if not member_id:
        return None

    try:
        uuid.UUID(str(member_id))
    except (TypeError, ValueError):
        return None

    member = (
        get_user_model()
        .objects.prefetch_related("contact_emails")
        .filter(pk=member_id, is_staff=True, is_active=True)
        .first()
    )
    if member is None:
        return None
    return member


def get_last_admin_login_summary(request):
    member = get_last_admin_login_member(request)
    if member is None:
        return None

    return {"name": get_admin_member_display_name(member)}


def get_admin_member_display_name(member):
    return member.get_full_name() or "Admin user"


def set_last_admin_login_cookie(response, member):
    response.set_signed_cookie(
        LAST_ADMIN_LOGIN_COOKIE_NAME,
        str(member.pk),
        max_age=LAST_ADMIN_LOGIN_COOKIE_MAX_AGE,
        path=_LAST_ADMIN_LOGIN_COOKIE_PATH,
        secure=getattr(settings, "SESSION_COOKIE_SECURE", False),
        httponly=True,
        samesite=getattr(settings, "SESSION_COOKIE_SAMESITE", "Lax"),
    )
    return response


def render_admin_login(request, *, form, step: str, email: str = "", **extra):
    next_param = request.GET.get("next", "")
    next_qs = f"&next={next_param}" if next_param else ""
    use_different_account = request.GET.get("different") == "1"
    hide_email = request.session.get(_SESSION_HIDE_EMAIL, False)
    code_recipient_name = ""
    if step == "code" and hide_email:
        member = get_admin_login_member(request)
        if member is not None:
            code_recipient_name = get_admin_member_display_name(member)

    context = admin.site.each_context(request)
    context.update(
        {
            "site_title": admin.site.site_title,
            "site_header": admin.site.site_header,
            "title": "Log in",
            "password_mode_url": f"?mode=password{next_qs}",
            "email_code_mode_url": f"?step=email{next_qs}",
            "different_email_url": f"?step=email&different=1{next_qs}",
            "step": step,
            "form": form,
            "email": email,
            "hide_email": hide_email,
            "code_recipient_name": code_recipient_name,
            "last_admin_user": (
                get_last_admin_login_summary(request)
                if step != "code" and not use_different_account
                else None
            ),
        }
    )
    context.update(extra)
    return render(request, "admin/login.html", context)


def _password_rate_key(request):
    client_address = request.META.get("REMOTE_ADDR", "unknown")
    return "".join((_RATE_LIMIT_PREFIX, client_address))
