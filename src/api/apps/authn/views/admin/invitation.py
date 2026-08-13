"""
View for accepting admin invitations (plain Django, not DRF).
"""

from django.contrib import admin
from django.contrib.auth.password_validation import validate_password
from django.core.cache import cache
from django.db import transaction
from django.http import HttpResponse
from django.shortcuts import render
from django.views import View

from apps.authn.forms.invitation import AcceptInvitationForm
from apps.authn.models import ContactEmail
from apps.authn.models.members.admin_invitation import AdminInvitation

_INVITATION_RATE_LIMIT = 10  # max attempts per token per hour

Member = None  # resolved lazily


def _get_member_model():
    global Member
    if Member is None:
        from django.contrib.auth import get_user_model

        Member = get_user_model()
    return Member


def _get_unfold_context(request):
    """Get Unfold theme context (colors, border_radius, theme) from the admin site."""
    site = admin.site
    if hasattr(site, "each_context"):
        ctx = site.each_context(request)
        return {k: ctx[k] for k in ("colors", "border_radius", "theme") if k in ctx}
    return {}


class AcceptInvitationView(View):
    """Standalone Django view for accepting admin invitations."""

    def get(self, request, token):
        invitation = self._get_invitation(token)
        if invitation is None:
            return render(
                request, "authn/invitation/invalid.html", _get_unfold_context(request), status=400
            )

        existing = self._get_verified_member(invitation)
        if existing:
            self._upgrade_member(existing, invitation)
            return render(
                request,
                "authn/invitation/already_registered.html",
                {"email": invitation.email, **_get_unfold_context(request)},
            )

        form = AcceptInvitationForm(initial={"email": invitation.email})
        return render(
            request,
            "authn/invitation/accept.html",
            {"form": form, "invitation": invitation, **_get_unfold_context(request)},
        )

    def post(self, request, token):
        cache_key = f"invitation-rate:{token}"
        attempts = cache.get(cache_key, 0)
        if attempts >= _INVITATION_RATE_LIMIT:
            return HttpResponse(
                "Too many attempts. Please try again later.", status=429, content_type="text/plain"
            )
        cache.set(cache_key, attempts + 1, timeout=3600)

        invitation = self._get_invitation(token)
        if invitation is None:
            return render(
                request, "authn/invitation/invalid.html", _get_unfold_context(request), status=400
            )

        existing = self._get_verified_member(invitation)
        if existing:
            self._upgrade_member(existing, invitation)
            return render(
                request,
                "authn/invitation/already_registered.html",
                {"email": invitation.email, **_get_unfold_context(request)},
            )

        form = AcceptInvitationForm(request.POST, initial={"email": invitation.email})
        if not form.is_valid():
            return render(
                request,
                "authn/invitation/accept.html",
                {"form": form, "invitation": invitation, **_get_unfold_context(request)},
            )

        with transaction.atomic():
            # noinspection PyPep8Naming
            MemberModel = _get_member_model()
            member = MemberModel(
                first_name=form.cleaned_data["first_name"],
                last_name=form.cleaned_data["last_name"],
                is_staff=True,
                is_active=True,
            )
            password = form.cleaned_data["password1"]
            validate_password(password, user=member)
            member.set_password(password)
            member.save()

            self._attach_invitation_email(member, invitation)
            invitation.mark_accepted(member)

        return render(
            request,
            "authn/invitation/success.html",
            {"member": member, **_get_unfold_context(request)},
        )

    # noinspection PyMethodMayBeStatic
    def _get_invitation(self, token):
        try:
            invitation = AdminInvitation.objects.get(token=token)
        except AdminInvitation.DoesNotExist:
            return None

        if not invitation.is_valid:
            if invitation.status == AdminInvitation.Status.PENDING and invitation.is_expired:
                invitation.mark_expired()
            return None

        return invitation

    # noinspection PyMethodMayBeStatic
    def _get_verified_member(self, invitation):
        contact = (
            ContactEmail.objects.filter(
                email_address__iexact=invitation.email,
                verified=True,
                member__isnull=False,
            )
            .select_related("member")
            .first()
        )
        return contact.member if contact else None

    # noinspection PyMethodMayBeStatic
    def _attach_invitation_email(self, member, invitation):
        contact = (
            ContactEmail.objects.select_for_update()
            .filter(email_address__iexact=invitation.email)
            .first()
        )
        if contact is None:
            ContactEmail.objects.create(
                member=member,
                email_address=invitation.email,
                email_type="primary",
                verified=True,
                subscribe=True,
            )
            return

        contact.member = member
        contact.email_type = "primary"
        contact.verified = True
        contact.save(update_fields=["member", "email_type", "verified", "updated_at"])

    # noinspection PyMethodMayBeStatic
    def _upgrade_member(self, member, invitation):
        # Upgrade the member and mark the invitation accepted atomically so a
        # failure between the two writes can't leave a staff-upgraded member with
        # a still-PENDING invitation.
        with transaction.atomic():
            member.is_staff = True
            member.is_active = True
            member.save(update_fields=["is_staff", "is_active", "updated_at"])
            invitation.mark_accepted(member)
