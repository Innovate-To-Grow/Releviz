"""Views for public passwordless phone-auth flows (signup + login via SMS code)."""

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.constants import (
    PHONE_VERIFICATION_DELIVERY_FAILED,
    VERIFICATION_INVALID,
    VERIFICATION_THROTTLED,
)
from apps.authn.security.throttles import EmailCodeVerifyThrottle, PhoneAuthCodeRequestThrottle
from apps.authn.serializers import (
    UnifiedPhoneAuthRequestSerializer,
    UnifiedPhoneAuthVerifySerializer,
)
from apps.authn.services import (
    PhoneAccountInactive,
    PhoneVerificationDeliveryError,
    PhoneVerificationInvalid,
    PhoneVerificationThrottled,
    resolve_or_create_member_by_phone,
)
from apps.authn.services.contacts.contact_phones import national_to_e164, normalize_to_national
from apps.authn.services.sms import check_phone_verification

from ..helpers import build_auth_success_payload


class PhoneAuthRequestCodeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [PhoneAuthCodeRequestThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = UnifiedPhoneAuthRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        try:
            payload = serializer.save()
        except PhoneVerificationThrottled:
            return Response({"detail": VERIFICATION_THROTTLED}, status=status.HTTP_429_TOO_MANY_REQUESTS)
        except PhoneVerificationDeliveryError:
            return Response({"detail": PHONE_VERIFICATION_DELIVERY_FAILED}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(payload, status=status.HTTP_202_ACCEPTED)


class PhoneAuthVerifyCodeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    # Verify spends no SMS budget (it only checks the cached OTP), so the shared
    # anon verify throttle is sufficient here.
    throttle_classes = [EmailCodeVerifyThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = UnifiedPhoneAuthVerifySerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        phone_number = serializer.validated_data.get("phone_number")
        region = serializer.validated_data["region"]
        code = serializer.validated_data["code"]
        challenge_id = serializer.validated_data.get("challenge_id")

        e164 = None
        if phone_number:
            national = normalize_to_national(phone_number, region)
            e164 = national_to_e164(national, region)

        def complete_auth(challenge):
            verified_e164 = getattr(challenge, "phone_number", None) or e164
            if not verified_e164:
                raise PhoneVerificationInvalid
            national = normalize_to_national(verified_e164, region)
            member, flow = resolve_or_create_member_by_phone(national, region)
            message = "Login successful." if flow == "login" else "Registration successful."
            return build_auth_success_payload(member, message)

        try:
            payload = check_phone_verification(
                e164,
                code,
                challenge_id=challenge_id,
                purpose="phone_auth",
                context_identifier=region,
                approved_callback=complete_auth,
            )
        except PhoneVerificationInvalid:
            return Response({"detail": VERIFICATION_INVALID}, status=status.HTTP_400_BAD_REQUEST)
        except PhoneVerificationThrottled:
            return Response({"detail": VERIFICATION_THROTTLED}, status=status.HTTP_429_TOO_MANY_REQUESTS)
        except PhoneVerificationDeliveryError:
            return Response({"detail": PHONE_VERIFICATION_DELIVERY_FAILED}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except PhoneAccountInactive:
            # A deactivated account must not be revived via phone login; mirror
            # the email flow's generic invalid-code 400 (no enumeration leak).
            return Response({"detail": VERIFICATION_INVALID}, status=status.HTTP_400_BAD_REQUEST)
        return Response(payload, status=status.HTTP_200_OK)
