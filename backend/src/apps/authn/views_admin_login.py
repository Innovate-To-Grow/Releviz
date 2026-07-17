from django.contrib import admin
from django.contrib.auth import login
from django.shortcuts import redirect, render
from django.utils.decorators import method_decorator
from django.utils.http import url_has_allowed_host_and_scheme
from django.views import View
from django.views.decorators.cache import never_cache

from apps.authn.forms import AdminPasswordForm
from apps.authn.security import consume_request_rate_limit
from apps.authn.services import send_login_alert


def safe_admin_next(request):
    next_url = request.GET.get("next") or request.POST.get("next", "")
    if next_url and url_has_allowed_host_and_scheme(next_url, allowed_hosts={request.get_host()}):
        return next_url
    return "/admin/"


@method_decorator(never_cache, name="dispatch")
class AdminLoginView(View):
    def get_context(self, request, form, *, status_next):
        context = admin.site.each_context(request)
        context.update(
            {
                "app_path": request.path,
                "form": form,
                "next": status_next,
                "site_header": admin.site.site_header,
                "site_title": admin.site.site_title,
                "title": "Log in",
            }
        )
        return context

    def get(self, request):
        if request.user.is_authenticated and request.user.is_staff:
            return redirect(safe_admin_next(request))
        return render(
            request,
            "admin/login.html",
            self.get_context(
                request,
                AdminPasswordForm(request),
                status_next=request.GET.get("next", ""),
            ),
        )

    def post(self, request):
        if request.user.is_authenticated and request.user.is_staff:
            return redirect(safe_admin_next(request))
        decision = consume_request_rate_limit(
            "admin_login",
            request,
            request.POST.get("email", ""),
        )
        if not decision.allowed:
            form = AdminPasswordForm(
                request,
                data={"email": request.POST.get("email", "")},
            )
            form.is_valid()
            form.errors.pop("password", None)
            form.add_error(None, "Too many login attempts. Please try again later.")
            response = render(
                request,
                "admin/login.html",
                self.get_context(request, form, status_next=request.POST.get("next", "")),
                status=429,
            )
            response["Retry-After"] = str(decision.retry_after)
            return response
        form = AdminPasswordForm(request, data=request.POST)
        if form.is_valid():
            user = form.get_user()
            login(request, user)
            send_login_alert(
                user,
                request=request,
                method="admin password",
                idempotency_token=request.session.session_key or "",
            )
            return redirect(safe_admin_next(request))
        return render(
            request,
            "admin/login.html",
            self.get_context(request, form, status_next=request.POST.get("next", "")),
            status=400,
        )
