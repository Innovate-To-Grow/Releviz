"""Views for public email-code auth flows."""

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.models.security import EmailAuthChallenge
from apps.authn.security.throttles import (
    EmailCodeRequestThrottle,
    EmailCodeVerifyThrottle,
    PhoneAuthCodeRequestThrottle,
)
from apps.authn.serializers import (
    LoginCodeRequestSerializer,
    LoginCodeVerifySerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    PasswordResetVerifySerializer,
    RegisterResendCodeSerializer,
    RegisterVerifyCodeSerializer,
    UnifiedEmailAuthRequestSerializer,
    UnifiedEmailAuthVerifySerializer,
)
from apps.authn.services import AuthChallengeInvalid

from ..helpers import build_auth_success_payload
from .email_code_helpers import auth_challenge_response, request_code_response

Member = get_user_model()


class LoginCodeRequestView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [EmailCodeRequestThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        return request_code_response(request, LoginCodeRequestSerializer)


class EmailAuthRequestCodeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [EmailCodeRequestThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        return request_code_response(request, UnifiedEmailAuthRequestSerializer)


class LoginCodeVerifyView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [EmailCodeVerifyThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = LoginCodeVerifySerializer(
            data=request.data,
            context={"approved_callback": _complete_login},
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            serializer.validated_data["approved_result"],
            status=status.HTTP_200_OK,
        )


class EmailAuthVerifyCodeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [EmailCodeVerifyThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = UnifiedEmailAuthVerifySerializer(
            data=request.data,
            context={"approved_callback": _complete_unified_auth},
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            serializer.validated_data["approved_result"],
            status=status.HTTP_200_OK,
        )


class RegisterVerifyCodeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [EmailCodeVerifyThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = RegisterVerifyCodeSerializer(
            data=request.data,
            context={"approved_callback": _complete_registration},
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            serializer.validated_data["approved_result"],
            status=status.HTTP_200_OK,
        )


class RegisterResendCodeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [EmailCodeRequestThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        return request_code_response(request, RegisterResendCodeSerializer)


class PasswordResetRequestView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [EmailCodeRequestThrottle]

    def get_throttles(self):
        # A phone identifier triggers an SMS send, so bound it with the stricter
        # per-IP SMS throttle instead of the looser email-code throttle. The channel
        # is inferred from the identifier before the view body runs.
        data = self.request.data if isinstance(self.request.data, dict) else {}
        identifier = str(data.get("identifier") or data.get("email") or "")
        if identifier and "@" not in identifier and any(ch.isdigit() for ch in identifier):
            return [PhoneAuthCodeRequestThrottle()]
        return [EmailCodeRequestThrottle()]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        return request_code_response(request, PasswordResetRequestSerializer)


class PasswordResetVerifyView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [EmailCodeVerifyThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        return auth_challenge_response(request, PasswordResetVerifySerializer)


class PasswordResetConfirmView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [EmailCodeVerifyThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        return auth_challenge_response(request, PasswordResetConfirmSerializer)


def _link_email_subscriber(member):
    """Link anonymous ContactEmail records to a newly activated member."""
    from apps.authn.models import ContactEmail

    primary_email = member.get_primary_email()
    if primary_email:
        ContactEmail.objects.filter(
            email_address__iexact=primary_email,
            member__isnull=True,
        ).update(member=member)


def _mark_contact_email_verified(member, email_address):
    """Mark the member's ContactEmail as verified after successful code verification."""
    from apps.authn.models import ContactEmail

    ContactEmail.objects.filter(
        member=member,
        email_address__iexact=email_address,
        verified=False,
    ).update(verified=True)


def _lock_challenge_member(challenge):
    """Serialize auth completion against account/contact mutations."""
    return Member.objects.select_for_update().get(pk=challenge.member_id)


def _complete_login(challenge):
    member = _lock_challenge_member(challenge)
    if not member.is_active:
        raise AuthChallengeInvalid("Verification code is invalid or has expired.")
    _mark_contact_email_verified(member, challenge.target_email)
    return build_auth_success_payload(member, "Login successful.")


def _complete_registration(challenge):
    member = _lock_challenge_member(challenge)
    if not member.is_active:
        member.is_active = True
        member.save(update_fields=["is_active", "updated_at"])
        _link_email_subscriber(member)
    _mark_contact_email_verified(member, challenge.target_email)
    return build_auth_success_payload(member, "Email verified. Registration successful.")


def _complete_unified_auth(challenge):
    if challenge.purpose == EmailAuthChallenge.Purpose.REGISTER:
        return _complete_registration(challenge)
    return _complete_login(challenge)
