import logging

from django.contrib import auth
from django.contrib.auth import authenticate
from django.shortcuts import redirect

from apps.authn.views.admin.login_helpers import (
    clear_admin_login_session,
    clear_password_rate_limit,
    get_last_admin_login_member,
    is_password_throttled,
    record_password_failure,
    render_admin_login,
    safe_admin_next,
    set_last_admin_login_cookie,
)

logger = logging.getLogger(__name__)


class PasswordLoginMixin:
    # noinspection PyMethodMayBeStatic
    def _handle_password_step(self, request):
        import apps.authn.views.admin.login as login_api

        if request.POST.get("remembered_admin") == "1":
            return self._handle_remembered_password_step(request)

        if is_password_throttled(request):
            form = login_api.AdminPasswordForm(request.POST)
            form.add_error(None, "Too many login attempts. Please try again later.")
            return render_admin_login(request, step="password", form=form)

        form = login_api.AdminPasswordForm(request.POST)
        if not form.is_valid():
            return render_admin_login(request, step="password", form=form)

        member = authenticate(
            request,
            username=form.cleaned_data["email"].strip().lower(),
            password=form.cleaned_data["password"],
        )
        if member is None or not member.is_staff or not member.is_active:
            record_password_failure(request)
            form.add_error(None, "Invalid email or password.")
            return render_admin_login(request, step="password", form=form)

        return _finish_password_login(request, member, "Admin login via password: %s")

    def _handle_remembered_password_step(self, request):
        import apps.authn.views.admin.login as login_api

        if is_password_throttled(request):
            form = login_api.AdminRememberedPasswordForm(request.POST)
            form.add_error(None, "Too many login attempts. Please try again later.")
            return render_admin_login(request, step="password", form=form)

        form = login_api.AdminRememberedPasswordForm(request.POST)
        if not form.is_valid():
            return render_admin_login(request, step="password", form=form)

        member = get_last_admin_login_member(request)
        if member is None:
            return render_admin_login(
                request,
                step="password",
                form=login_api.AdminPasswordForm(),
                error="Please enter your email to continue.",
            )

        if not member.check_password(form.cleaned_data["password"]):
            record_password_failure(request)
            form.add_error(None, "Invalid password.")
            return render_admin_login(request, step="password", form=form)

        return _finish_password_login(
            request,
            member,
            "Admin login via remembered password: %s",
        )


def _finish_password_login(request, member, log_message):
    clear_password_rate_limit(request)
    auth.login(request, member, backend="apps.authn.security.backends.EmailAuthBackend")
    clear_admin_login_session(request)
    logger.info(log_message, member.get_primary_email())
    response = redirect(safe_admin_next(request))
    return set_last_admin_login_cookie(response, member)
