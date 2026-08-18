"""
View for accepting admin invitations (plain Django, not DRF).
"""

from django.contrib import admin
from django.contrib.auth.password_validation import validate_password
from django.db import IntegrityError, transaction
from django.http import HttpResponse
from django.shortcuts import render
from django.views import View

from apps.authn.forms.invitation import AcceptInvitationForm
from apps.authn.models import ContactEmail
from apps.authn.models.members.admin_invitation import AdminInvitation
from apps.authn.security import consume_request_rate_limit

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
            return render(
                request,
                "authn/invitation/already_registered.html",
                {
                    "email": invitation.email,
                    "invitation": invitation,
                    "accepted": False,
                    **_get_unfold_context(request),
                },
            )

        form = AcceptInvitationForm(initial={"email": invitation.email})
        return render(
            request,
            "authn/invitation/accept.html",
            {"form": form, "invitation": invitation, **_get_unfold_context(request)},
        )

    def post(self, request, token):
        decision = consume_request_rate_limit(
            "admin_invitation_accept",
            request,
            identity=token,
        )
        if not decision.allowed:
            response = HttpResponse(
                "Too many attempts. Please try again later.", status=429, content_type="text/plain"
            )
            response["Retry-After"] = str(decision.retry_after)
            return response

        invitation = self._get_invitation(token)
        if invitation is None:
            return render(
                request, "authn/invitation/invalid.html", _get_unfold_context(request), status=400
            )

        existing = self._get_verified_member(invitation)
        if existing:
            with transaction.atomic():
                locked_invitation = self._get_invitation(token, for_update=True)
                if locked_invitation is None:
                    return render(
                        request,
                        "authn/invitation/invalid.html",
                        _get_unfold_context(request),
                        status=400,
                    )
                locked_member = self._get_verified_member(locked_invitation, for_update=True)
                if locked_member is None:
                    return render(
                        request,
                        "authn/invitation/invalid.html",
                        _get_unfold_context(request),
                        status=400,
                    )
                self._upgrade_member(locked_member, locked_invitation)
            return render(
                request,
                "authn/invitation/already_registered.html",
                {
                    "email": locked_invitation.email,
                    "accepted": True,
                    **_get_unfold_context(request),
                },
            )

        form = AcceptInvitationForm(request.POST, initial={"email": invitation.email})
        if not form.is_valid():
            return render(
                request,
                "authn/invitation/accept.html",
                {"form": form, "invitation": invitation, **_get_unfold_context(request)},
            )

        with transaction.atomic():
            invitation = self._get_invitation(token, for_update=True)
            if invitation is None:
                return render(
                    request,
                    "authn/invitation/invalid.html",
                    _get_unfold_context(request),
                    status=400,
                )
            # A verified account may have claimed this address after the form
            # was rendered. Serialize that race into an upgrade, not a second
            # staff account.
            existing = self._get_verified_member(invitation, for_update=True)
            if existing is not None:
                self._upgrade_member(existing, invitation)
                return render(
                    request,
                    "authn/invitation/already_registered.html",
                    {
                        "email": invitation.email,
                        "accepted": True,
                        **_get_unfold_context(request),
                    },
                )
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

            resolved_member = self._attach_invitation_email(member, invitation)
            if resolved_member.pk != member.pk:
                member.delete()
                self._upgrade_member(resolved_member, invitation)
                return render(
                    request,
                    "authn/invitation/already_registered.html",
                    {
                        "email": invitation.email,
                        "accepted": True,
                        **_get_unfold_context(request),
                    },
                )

            invitation.mark_accepted(member)

        return render(
            request,
            "authn/invitation/success.html",
            {"member": member, **_get_unfold_context(request)},
        )

    # noinspection PyMethodMayBeStatic
    def _get_invitation(self, token, *, for_update=False):
        queryset = AdminInvitation.objects
        if for_update:
            queryset = queryset.select_for_update()
        try:
            invitation = queryset.get(token=token)
        except AdminInvitation.DoesNotExist:
            return None

        if not invitation.is_valid:
            if (
                for_update
                and invitation.status == AdminInvitation.Status.PENDING
                and invitation.is_expired
            ):
                invitation.mark_expired()
            return None

        return invitation

    # noinspection PyMethodMayBeStatic
    def _get_verified_member(self, invitation, *, for_update=False):
        queryset = ContactEmail.objects
        if for_update:
            queryset = queryset.select_for_update()
        contact = (
            queryset.filter(
                email_address__iexact=invitation.email,
                verified=True,
                member__isnull=False,
            )
            .select_related("member")
            .first()
        )
        if contact is None:
            return None
        if for_update:
            return _get_member_model().objects.select_for_update().get(pk=contact.member_id)
        return contact.member

    # noinspection PyMethodMayBeStatic
    def _get_contact_for_update(self, invitation):
        return (
            ContactEmail.objects.select_for_update()
            .filter(email_address__iexact=invitation.email)
            .first()
        )

    # noinspection PyMethodMayBeStatic
    def _resolve_invitation_contact(self, contact, candidate):
        # A verified address is an established identity. If another transaction
        # verified it while this invitation was being accepted, keep its owner
        # and upgrade that account instead of moving the address.
        if contact.verified and contact.member_id is not None:
            return _get_member_model().objects.select_for_update().get(pk=contact.member_id)

        # An unverified address is not yet an established identity. Possession
        # of the emailed invitation proves control, so it may be claimed by the
        # newly-created account while the contact row is locked.
        contact.member = candidate
        contact.email_type = "primary"
        contact.verified = True
        contact.save(update_fields=["member", "email_type", "verified", "updated_at"])
        return candidate

    # noinspection PyMethodMayBeStatic
    def _attach_invitation_email(self, member, invitation):
        contact = self._get_contact_for_update(invitation)
        if contact is not None:
            return self._resolve_invitation_contact(contact, member)

        # select_for_update cannot lock an absent row. Keep the insert inside
        # its own savepoint so a concurrent case-insensitive insert can be
        # resolved without poisoning the surrounding invitation transaction.
        try:
            with transaction.atomic():
                ContactEmail.objects.create(
                    member=member,
                    email_address=invitation.email,
                    email_type="primary",
                    verified=True,
                    subscribe=True,
                )
        except IntegrityError:
            contact = self._get_contact_for_update(invitation)
            if contact is None:
                raise
            return self._resolve_invitation_contact(contact, member)

        return member

    # noinspection PyMethodMayBeStatic
    def _upgrade_member(self, member, invitation):
        member.is_staff = True
        member.is_active = True
        member.access_level = member.AccessLevel.FULL
        member.save(update_fields=["is_staff", "is_active", "access_level", "updated_at"])
        invitation.mark_accepted(member)
