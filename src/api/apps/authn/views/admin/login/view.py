from django.shortcuts import redirect
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.cache import never_cache

from apps.authn.views.admin.login_helpers import (
    clear_admin_login_session,
    get_admin_login_state,
    render_admin_login,
    safe_admin_next,
)

from .email_code import EmailCodeLoginMixin
from .password import PasswordLoginMixin


@method_decorator(never_cache, name="dispatch")
class AdminLoginView(PasswordLoginMixin, EmailCodeLoginMixin, View):
    """Admin login: email code flow OR password flow."""

    # noinspection PyMethodMayBeStatic
    def get(self, request):
        import apps.authn.views.admin.login as login_api

        if request.user.is_authenticated and request.user.is_staff:
            return redirect(safe_admin_next(request))

        if request.GET.get("mode") == "password":
            clear_admin_login_session(request)
            return render_admin_login(
                request,
                step="password",
                form=login_api.AdminPasswordForm(),
            )

        if request.GET.get("step") == "email":
            clear_admin_login_session(request)

        step, email, _ = get_admin_login_state(request)
        if step == "code":
            return render_admin_login(
                request,
                step="code",
                email=email,
                form=login_api.AdminCodeForm(),
            )
        return render_admin_login(
            request,
            step="email",
            form=login_api.AdminEmailForm(),
        )

    def post(self, request):
        if request.user.is_authenticated and request.user.is_staff:
            return redirect(safe_admin_next(request))

        if request.POST.get("action") == "remembered_code":
            return self._handle_remembered_code_step(request)
        if request.POST.get("mode") == "password":
            return self._handle_password_step(request)

        step, _, _ = get_admin_login_state(request)
        if step == "code":
            return self._handle_code_step(request)
        return self._handle_email_step(request)
