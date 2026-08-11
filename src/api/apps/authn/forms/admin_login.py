"""
Admin login forms for the two-step email verification code flow.
"""

from django import forms
from django.utils.translation import gettext_lazy as _

from apps.authn.models import ContactEmail


class AdminEmailForm(forms.Form):
    """Step 1: email entry."""

    email = forms.EmailField(
        label=_("Email"),
        widget=forms.EmailInput(attrs={"placeholder": _("Email"), "autofocus": True}),
    )

    def clean_email(self):
        email = self.cleaned_data["email"].strip().lower()
        contact = (
            ContactEmail.objects.select_related("member")
            .filter(
                email_address__iexact=email,
                member__is_staff=True,
                member__is_active=True,
                verified=True,
            )
            .first()
        )
        if contact is None:
            raise forms.ValidationError(_("Unable to send verification code."))
        self.cleaned_data["member"] = contact.member
        return email


class AdminCodeForm(forms.Form):
    """Step 2: 6-digit verification code entry."""

    code = forms.CharField(
        label=_("Verification code"),
        min_length=6,
        max_length=6,
        widget=forms.TextInput(
            attrs={
                "placeholder": _("000000"),
                "inputmode": "numeric",
                "pattern": "[0-9]{6}",
                "autocomplete": "one-time-code",
                "autofocus": True,
            }
        ),
    )


class AdminPasswordForm(forms.Form):
    """Password-based admin login: email + password."""

    email = forms.EmailField(
        label=_("Email"),
        widget=forms.EmailInput(attrs={"placeholder": _("Email"), "autofocus": True, "autocomplete": "email"}),
    )
    password = forms.CharField(
        label=_("Password"),
        widget=forms.PasswordInput(attrs={"placeholder": _("Password"), "autocomplete": "current-password"}),
    )


class AdminRememberedPasswordForm(forms.Form):
    """Password-based admin login for the signed last-admin cookie."""

    password = forms.CharField(
        label=_("Password"),
        widget=forms.PasswordInput(attrs={"placeholder": _("Password"), "autocomplete": "current-password"}),
    )
