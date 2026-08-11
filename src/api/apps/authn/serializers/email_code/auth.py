"""Login, registration, and unified email auth serializers."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from rest_framework import serializers

from apps.authn.constants import VERIFICATION_INVALID
from apps.authn.services import (
    AuthChallengeInvalid,
    claim_unclaimed_contact_email,
    get_pending_registration_member,
    issue_email_challenge,
    registration_email_conflicts,
    resolve_auth_email,
    verify_email_code_for_purposes,
)

from .base import _CODE_RE, PURPOSE, BaseCodeVerifySerializer, BaseEmailSerializer

Member = get_user_model()
EMAIL_AUTH_SOURCE_CHOICES = (
    ("login", "login"),
    ("subscribe", "subscribe"),
    ("event_registration", "event_registration"),
)


class LoginCodeRequestSerializer(BaseEmailSerializer):
    def save(self):
        resolved = resolve_auth_email(self.validated_data["email"], require_active=True)
        if resolved is not None:
            issue_email_challenge(
                member=resolved.member,
                purpose=PURPOSE.LOGIN,
                target_email=resolved.delivery_email,
                link_flow="login",
                link_source="login",
            )
        return {"message": "If an eligible account exists, a verification code has been sent."}


class LoginCodeVerifySerializer(BaseCodeVerifySerializer):
    purpose = PURPOSE.LOGIN


class UnifiedEmailAuthRequestSerializer(BaseEmailSerializer):
    source = serializers.ChoiceField(choices=EMAIL_AUTH_SOURCE_CHOICES, required=False, default="login")
    # Event slug carried into the emailed auth link so the user lands back on the event they
    # were registering for. Format-validated only; a stale slug degrades to the event list.
    event = serializers.SlugField(required=False, allow_blank=True, default="")

    def _create_pending_member(self, email: str) -> Member:
        from apps.authn.models import ContactEmail

        member = Member(
            is_active=False,
            first_name="",
            last_name="",
            organization="",
        )
        member.set_unusable_password()
        member.save()
        if claim_unclaimed_contact_email(email, member=member) is None:
            pending_member = get_pending_registration_member(email)
            if pending_member is not None:
                # Member.delete() is a soft delete; these race-lost pending rows are intentionally retained.
                member.delete()
                return pending_member
            try:
                ContactEmail.objects.create(
                    member=member,
                    email_address=email,
                    email_type="primary",
                    verified=False,
                    subscribe=True,
                )
            except IntegrityError as exc:
                pending_member = get_pending_registration_member(email)
                # Member.delete() is a soft delete; these race-lost pending rows are intentionally retained.
                member.delete()
                if pending_member is not None:
                    return pending_member
                raise serializers.ValidationError({"email": "This email cannot be used for registration."}) from exc
        return member

    def save(self):
        email = self.validated_data["email"]
        source = self.validated_data["source"]
        event = self.validated_data.get("event", "")
        generic_response = {"message": "Check your email for a verification code."}
        resolved = resolve_auth_email(email, require_active=True)
        if resolved is not None:
            issue_email_challenge(
                member=resolved.member,
                purpose=PURPOSE.LOGIN,
                target_email=resolved.delivery_email,
                link_flow="auth",
                link_source=source,
                link_event=event,
            )
            return generic_response

        pending_member = get_pending_registration_member(email)
        if registration_email_conflicts(
            email,
            exclude_member_id=pending_member.pk if pending_member else None,
            allow_unclaimed=True,
        ):
            raise serializers.ValidationError({"email": "This email cannot be used for registration."})

        member = pending_member or self._create_pending_member(email)
        issue_email_challenge(
            member=member,
            purpose=PURPOSE.REGISTER,
            target_email=email,
            link_flow="auth",
            link_source=source,
            link_event=event,
        )
        return generic_response


class UnifiedEmailAuthVerifySerializer(BaseEmailSerializer):
    code = serializers.CharField(required=True, max_length=6, min_length=6)

    def validate_code(self, value: str) -> str:
        normalized = value.strip()
        if not _CODE_RE.match(normalized):
            raise serializers.ValidationError("Code must be a 6-digit number.")
        return normalized

    def validate(self, attrs: dict) -> dict:
        attrs = super().validate(attrs)
        approved_callback = self.context.get("approved_callback")
        try:
            result = verify_email_code_for_purposes(
                purposes=[PURPOSE.LOGIN, PURPOSE.REGISTER],
                target_email=attrs["email"],
                code=attrs["code"],
                approved_callback=approved_callback,
            )
        except AuthChallengeInvalid as exc:
            raise serializers.ValidationError({"detail": VERIFICATION_INVALID}) from exc

        if approved_callback is not None:
            attrs["approved_result"] = result
        else:
            attrs["challenge"] = result
            attrs["flow"] = "register" if result.purpose == PURPOSE.REGISTER else "login"
        return attrs


class RegisterVerifyCodeSerializer(BaseCodeVerifySerializer):
    purpose = PURPOSE.REGISTER


class RegisterResendCodeSerializer(BaseEmailSerializer):
    def save(self):
        from apps.authn.models import ContactEmail

        contact = (
            ContactEmail.objects.filter(email_address__iexact=self.validated_data["email"], member__is_active=False)
            .select_related("member")
            .first()
        )
        member = contact.member if contact else None
        if member is None:
            raise serializers.ValidationError({"email": "No pending registration was found for this email."})
        issue_email_challenge(
            member=member,
            purpose=PURPOSE.REGISTER,
            target_email=self.validated_data["email"],
            link_flow="register",
            link_source="register",
        )
        return {"message": "Verification code sent."}
