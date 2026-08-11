"""Password reset and password change serializers."""

from __future__ import annotations

import logging
import uuid

from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers

from apps.authn.constants import RECOVERY_CHANNEL_UNAVAILABLE, VERIFICATION_CONFIRM_INVALID, VERIFICATION_INVALID
from apps.authn.services import (
    AuthChallengeInvalid,
    NoRecoveryChannelError,
    PhoneVerificationError,
    PhoneVerificationInvalid,
    PhoneVerificationThrottled,
    consume_verification_token,
    delete_member_account,
    get_member_auth_emails,
    issue_email_challenge,
    normalize_email,
    request_sms_password_code,
    resolve_login_identifier,
    select_recovery_channel,
    verify_email_code_and_mint_token,
    verify_sms_password_code_and_mint,
)

from ..helpers import decrypt_password_pair
from .base import PURPOSE, BaseCodeVerifySerializer

logger = logging.getLogger(__name__)


def _identifier_value(data: dict) -> str:
    """Read the login identifier from ``identifier`` (preferred) or the legacy ``email`` alias."""
    return (data.get("identifier") or data.get("email") or "").strip()


class PasswordResetRequestSerializer(serializers.Serializer):
    """Request a password-reset code by email or phone (enumeration-safe).

    Accepts ``identifier`` (an email address or a phone number); ``email`` is kept
    as a backward-compatible alias. The response is identical whether or not an
    account exists, and the channel follows the identifier the caller supplied.
    """

    identifier = serializers.CharField(required=False, allow_blank=True)
    email = serializers.CharField(required=False, allow_blank=True)

    def save(self):
        # Always return an opaque ID so response shape cannot reveal whether the
        # identifier resolved. For an eligible SMS account it is replaced with
        # the durable challenge ID; email/unknown identifiers receive a decoy.
        challenge_id = str(uuid.uuid4())
        resolved = resolve_login_identifier(_identifier_value(self.validated_data), require_active=True)
        if resolved is not None:
            if resolved.via == "email":
                issue_email_challenge(
                    member=resolved.member,
                    purpose=PURPOSE.PASSWORD_RESET,
                    target_email=resolved.email,
                )
            else:
                try:
                    issued_challenge_id = request_sms_password_code(
                        member=resolved.member,
                        e164=resolved.e164,
                        purpose=PURPOSE.PASSWORD_RESET,
                    )
                    if issued_challenge_id:
                        challenge_id = issued_challenge_id
                except PhoneVerificationError:
                    # Stay enumeration-safe on this public endpoint: never surface
                    # per-number SMS send state. The generic response is returned
                    # regardless; the per-number send cap is the backstop.
                    logger.warning("Password-reset SMS send failed", exc_info=True)
        return {
            "message": "If an eligible account exists, a verification code has been sent.",
            "challenge_id": challenge_id,
        }


class PasswordResetVerifySerializer(serializers.Serializer):
    """Verify a password-reset code (email or SMS) and mint a verification token."""

    identifier = serializers.CharField(required=False, allow_blank=True)
    email = serializers.CharField(required=False, allow_blank=True)
    code = serializers.CharField(required=True, min_length=6, max_length=6)
    challenge_id = serializers.UUIDField(required=False)

    def validate(self, attrs: dict) -> dict:
        resolved = resolve_login_identifier(_identifier_value(attrs), require_active=True)
        if resolved is None:
            raise serializers.ValidationError({"detail": VERIFICATION_INVALID})

        if resolved.via == "email":
            try:
                _, attrs["verification_token"] = verify_email_code_and_mint_token(
                    purpose=PURPOSE.PASSWORD_RESET,
                    target_email=resolved.email,
                    code=attrs["code"],
                    member=resolved.member,
                )
            except AuthChallengeInvalid:
                raise serializers.ValidationError({"detail": VERIFICATION_INVALID}) from None
        else:
            try:
                attrs["verification_token"] = verify_sms_password_code_and_mint(
                    member=resolved.member,
                    purpose=PURPOSE.PASSWORD_RESET,
                    e164=resolved.e164,
                    code=attrs["code"],
                    challenge_id=attrs.get("challenge_id"),
                )
            except (PhoneVerificationInvalid, PhoneVerificationThrottled):
                raise serializers.ValidationError({"detail": VERIFICATION_INVALID}) from None
        return attrs

    def save(self):
        return {
            "message": "Verification code accepted.",
            "verification_token": self.validated_data["verification_token"],
        }


class PasswordResetConfirmSerializer(serializers.Serializer):
    identifier = serializers.CharField(required=False, allow_blank=True)
    email = serializers.CharField(required=False, allow_blank=True)
    verification_token = serializers.CharField(required=True)
    new_password = serializers.CharField(write_only=True, required=True)
    new_password_confirm = serializers.CharField(write_only=True, required=True)
    key_id = serializers.CharField(required=False, allow_blank=True)

    def validate(self, attrs: dict) -> dict:
        resolved = resolve_login_identifier(_identifier_value(attrs), require_active=True)
        if resolved is None:
            raise serializers.ValidationError({"detail": VERIFICATION_CONFIRM_INVALID})
        attrs["resolved_member"] = resolved.member
        attrs["decrypted_new_password"] = decrypt_password_pair(attrs, user=resolved.member)
        return attrs

    def save(self):
        new_password = self.validated_data["decrypted_new_password"]
        resolved_member = self.validated_data["resolved_member"]
        validate_password(new_password, user=resolved_member)
        try:
            challenge = consume_verification_token(
                purpose=PURPOSE.PASSWORD_RESET,
                verification_token=self.validated_data["verification_token"],
                member=resolved_member,
            )
        except AuthChallengeInvalid:
            raise serializers.ValidationError({"detail": VERIFICATION_CONFIRM_INVALID}) from None
        member = challenge.member
        member.set_password(new_password)
        member.save(update_fields=["password"])
        return {"message": "Password reset successfully."}


class ChangePasswordCodeRequestSerializer(serializers.Serializer):
    """Request a password-create/change verification code.

    The verification channel is chosen by ``select_recovery_channel`` (verified
    primary email -> any verified email -> verified phone via SMS). ``email`` is
    optional and only used to disambiguate when the member has several verified
    emails (legacy clients echo it); it must be one of the member's verified emails.
    """

    email = serializers.EmailField(required=False, allow_blank=True)

    def validate(self, attrs: dict) -> dict:
        member = self.context["request"].user
        requested = normalize_email(attrs["email"]) if attrs.get("email") else None
        if requested and requested not in set(get_member_auth_emails(member)):
            raise serializers.ValidationError({"email": "This email is not eligible for password change verification."})
        try:
            attrs["selected"] = select_recovery_channel(member, requested_email=requested)
        except NoRecoveryChannelError:
            raise serializers.ValidationError({"detail": RECOVERY_CHANNEL_UNAVAILABLE}) from None
        return attrs

    def save(self):
        member = self.context["request"].user
        selected = self.validated_data["selected"]
        if selected.channel == "email":
            issue_email_challenge(
                member=member,
                purpose=PURPOSE.PASSWORD_CHANGE,
                target_email=selected.target_email,
            )
        else:
            challenge_id = request_sms_password_code(
                member=member,
                e164=selected.e164,
                purpose=PURPOSE.PASSWORD_CHANGE,
            )
        payload = {
            "message": "Verification code sent.",
            "channel": selected.channel,
            "destination": selected.masked_destination,
        }
        if selected.channel == "sms":
            payload["challenge_id"] = challenge_id
        return payload


class ChangePasswordCodeVerifySerializer(serializers.Serializer):
    """Verify a password-change code (email or SMS) and mint a verification token.

    The channel is re-derived deterministically from member state, so the same
    channel chosen at request time is used here; ``email`` disambiguates the email
    case for members with several verified emails.
    """

    email = serializers.EmailField(required=False, allow_blank=True)
    code = serializers.CharField(required=True, min_length=6, max_length=6)
    channel = serializers.ChoiceField(choices=["email", "sms"], required=False)
    challenge_id = serializers.UUIDField(required=False)

    def validate(self, attrs: dict) -> dict:
        member = self.context["request"].user
        requested = normalize_email(attrs["email"]) if attrs.get("email") else None
        try:
            selected = select_recovery_channel(member, requested_email=requested)
        except NoRecoveryChannelError:
            raise serializers.ValidationError({"detail": RECOVERY_CHANNEL_UNAVAILABLE}) from None

        client_channel = attrs.get("channel")
        if client_channel and client_channel != selected.channel:
            raise serializers.ValidationError(
                {"detail": "Your contact methods changed since the code was sent. Please request a new code."}
            )

        if selected.channel == "email":
            try:
                _, attrs["verification_token"] = verify_email_code_and_mint_token(
                    purpose=PURPOSE.PASSWORD_CHANGE,
                    target_email=selected.target_email,
                    code=attrs["code"],
                    member=member,
                )
            except AuthChallengeInvalid:
                raise serializers.ValidationError({"detail": VERIFICATION_INVALID}) from None
        else:
            try:
                attrs["verification_token"] = verify_sms_password_code_and_mint(
                    member=member,
                    purpose=PURPOSE.PASSWORD_CHANGE,
                    e164=selected.e164,
                    code=attrs["code"],
                    challenge_id=attrs.get("challenge_id"),
                )
            except (PhoneVerificationInvalid, PhoneVerificationThrottled):
                raise serializers.ValidationError({"detail": VERIFICATION_INVALID}) from None

        attrs["channel"] = selected.channel
        return attrs

    def save(self):
        return {
            "message": "Verification code accepted.",
            "verification_token": self.validated_data["verification_token"],
            "channel": self.validated_data["channel"],
        }


class ChangePasswordCodeConfirmSerializer(serializers.Serializer):
    verification_token = serializers.CharField(required=True)
    new_password = serializers.CharField(write_only=True, required=True)
    new_password_confirm = serializers.CharField(write_only=True, required=True)
    key_id = serializers.CharField(required=False, allow_blank=True)

    def validate(self, attrs: dict) -> dict:
        attrs["decrypted_new_password"] = decrypt_password_pair(attrs, user=self.context["request"].user)
        return attrs

    def save(self):
        member = self.context["request"].user
        new_password = self.validated_data["decrypted_new_password"]
        validate_password(new_password, user=member)
        consume_verification_token(
            purpose=PURPOSE.PASSWORD_CHANGE,
            verification_token=self.validated_data["verification_token"],
            member=member,
        )
        member.set_password(new_password)
        member.save(update_fields=["password"])
        return {"message": "Password changed successfully."}


class DeleteAccountCodeRequestSerializer(serializers.Serializer):
    def save(self):
        member = self.context["request"].user
        email = member.get_primary_email()
        if not email:
            raise serializers.ValidationError(
                {"detail": "No verified email is available for account deletion. Add and verify an email first."}
            )

        issue_email_challenge(
            member=member,
            purpose=PURPOSE.ACCOUNT_DELETE,
            target_email=email,
        )
        return {"message": "Deletion verification code sent."}


class DeleteAccountCodeVerifySerializer(serializers.Serializer):
    code = serializers.CharField(required=True, max_length=6, min_length=6)

    def validate_code(self, value: str) -> str:
        return BaseCodeVerifySerializer().validate_code(value)

    def validate(self, attrs: dict) -> dict:
        member = self.context["request"].user
        email = member.get_primary_email()
        if not email:
            raise serializers.ValidationError(
                {"detail": "No verified email is available for account deletion. Add and verify an email first."}
            )

        try:
            challenge, verification_token = verify_email_code_and_mint_token(
                purpose=PURPOSE.ACCOUNT_DELETE,
                target_email=email,
                code=attrs["code"],
                member=member,
            )
        except AuthChallengeInvalid:
            raise serializers.ValidationError({"detail": VERIFICATION_INVALID}) from None

        if challenge.member != member:
            raise serializers.ValidationError({"detail": VERIFICATION_INVALID})

        attrs["challenge"] = challenge
        attrs["verification_token"] = verification_token
        return attrs

    def save(self):
        return {
            "message": "Deletion verification code accepted.",
            "verification_token": self.validated_data["verification_token"],
        }


class DeleteAccountCodeConfirmSerializer(serializers.Serializer):
    verification_token = serializers.CharField(required=True)

    def save(self):
        member = self.context["request"].user
        consume_verification_token(
            purpose=PURPOSE.ACCOUNT_DELETE,
            verification_token=self.validated_data["verification_token"],
            member=member,
        )
        delete_member_account(member=member)
        return {"message": "Account deleted successfully."}
