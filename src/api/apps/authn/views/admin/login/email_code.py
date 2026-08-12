import logging

from django.contrib import auth
from django.shortcuts import redirect

from apps.authn.views.admin.login_helpers import (
    clear_admin_login_session,
    get_admin_login_state,
    get_admin_member_display_name,
    get_last_admin_login_member,
    render_admin_login,
    safe_admin_next,
    set_admin_login_state,
    set_last_admin_login_cookie,
)

logger = logging.getLogger(__name__)


class EmailCodeLoginMixin:
    # noinspection PyMethodMayBeStatic
    def _handle_email_step(self, request):
        import apps.authn.views.admin.login as login_api

        form = login_api.AdminEmailForm(request.POST)
        if not form.is_valid():
            return render_admin_login(request, step="email", form=form)

        member = form.cleaned_data["member"]
        email = form.cleaned_data["email"]
        try:
            login_api.issue_email_challenge(
                member=member,
                purpose=login_api.PURPOSE,
                target_email=email,
            )
        except login_api.AuthChallengeThrottled as exc:
            form.add_error(None, str(exc))
            return render_admin_login(request, step="email", form=form)
        except login_api.AuthChallengeDeliveryError:
            form.add_error(None, "Failed to send verification code. Please try again later.")
            return render_admin_login(request, step="email", form=form)

        set_admin_login_state(
            request,
            step="code",
            email=email,
            member_id=str(member.pk),
        )
        return render_admin_login(
            request,
            step="code",
            email=email,
            form=login_api.AdminCodeForm(),
            message="A verification code has been sent to your email.",
        )

    def _handle_remembered_code_step(self, request):
        import apps.authn.views.admin.login as login_api

        member = get_last_admin_login_member(request)
        contact = member.get_primary_contact_email() if member else None
        if member is None or contact is None or not contact.verified:
            return render_admin_login(
                request,
                step="email",
                form=login_api.AdminEmailForm(),
                error="Unable to send verification code.",
            )

        try:
            login_api.issue_email_challenge(
                member=member,
                purpose=login_api.PURPOSE,
                target_email=contact.email_address,
            )
        except login_api.AuthChallengeThrottled as exc:
            return render_admin_login(
                request,
                step="email",
                form=login_api.AdminEmailForm(),
                error=str(exc),
            )
        except login_api.AuthChallengeDeliveryError:
            return render_admin_login(
                request,
                step="email",
                form=login_api.AdminEmailForm(),
                error="Failed to send verification code. Please try again later.",
            )

        set_admin_login_state(
            request,
            step="code",
            email=contact.email_address,
            member_id=str(member.pk),
            hide_email=True,
        )
        return render_admin_login(
            request,
            step="code",
            email=contact.email_address,
            form=login_api.AdminCodeForm(),
            message=(
                f"A verification code has been sent to {get_admin_member_display_name(member)}."
            ),
        )

    def _handle_code_step(self, request):
        import apps.authn.views.admin.login as login_api

        _, email, member_id = get_admin_login_state(request)
        if not email or not member_id:
            clear_admin_login_session(request)
            return render_admin_login(request, step="email", form=login_api.AdminEmailForm())

        if request.POST.get("action") == "resend":
            return self._handle_resend(request, email, member_id)

        form = login_api.AdminCodeForm(request.POST)
        if not form.is_valid():
            return render_admin_login(request, step="code", email=email, form=form)

        try:
            challenge = login_api.verify_email_code(
                purpose=login_api.PURPOSE,
                target_email=email,
                code=form.cleaned_data["code"],
            )
        except login_api.AuthChallengeInvalid:
            form.add_error(None, "Verification code is invalid or has expired.")
            return render_admin_login(request, step="code", email=email, form=form)

        member = challenge.member
        if not member.is_staff or not member.is_active:
            clear_admin_login_session(request)
            return render_admin_login(
                request,
                step="email",
                form=login_api.AdminEmailForm(),
                error="You do not have access to the admin panel.",
            )

        auth.login(request, member, backend="apps.authn.security.backends.EmailAuthBackend")
        clear_admin_login_session(request)
        logger.info("Admin login via email code: %s", member.get_primary_email())
        response = redirect(safe_admin_next(request))
        return set_last_admin_login_cookie(response, member)

    # noinspection PyMethodMayBeStatic
    def _handle_resend(self, request, email, member_id):
        import apps.authn.views.admin.login as login_api

        member = login_api.Member.objects.filter(
            pk=member_id,
            is_staff=True,
            is_active=True,
        ).first()
        if not member:
            clear_admin_login_session(request)
            return render_admin_login(request, step="email", form=login_api.AdminEmailForm())

        try:
            login_api.issue_email_challenge(
                member=member,
                purpose=login_api.PURPOSE,
                target_email=email,
            )
            message = "A new verification code has been sent."
        except login_api.AuthChallengeThrottled as exc:
            message = str(exc)
        except login_api.AuthChallengeDeliveryError:
            message = "Failed to send verification code. Please try again later."

        return render_admin_login(
            request,
            step="code",
            email=email,
            form=login_api.AdminCodeForm(),
            message=message,
        )
