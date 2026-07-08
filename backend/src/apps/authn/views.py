from django.db import transaction
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenRefreshView

from apps.authn.models import ContactEmail, ContactPhone, EmailAuthChallenge
from apps.authn.services import (
    active_keypair,
    auth_payload,
    complete_registration,
    issue_email_challenge,
    login_with_password,
    normalize_email,
    send_login_alert,
    send_registration_welcome,
    start_registration,
    user_payload,
    validate_password_pair,
    verify_email_challenge,
)
from apps.messaging.services import EmailDeliveryError


def validation_error_response(exc):
    if isinstance(exc, EmailDeliveryError):
        return Response({"detail": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
    detail = getattr(exc, "detail", None)
    if detail is None:
        detail = {"detail": str(exc)}
    return Response(detail, status=status.HTTP_400_BAD_REQUEST)


def maybe_debug_code(response_data: dict, issued):
    from django.conf import settings

    if settings.DEBUG:
        response_data["debug_code"] = issued.code
    return response_data


class PublicKeyView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        key = active_keypair()
        return Response({"key_id": str(key.key_id), "public_key": key.public_key_pem})


class RegisterView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        try:
            start_registration(request.data)
        except Exception as exc:  # noqa: BLE001
            return validation_error_response(exc)
        return Response(
            {"message": "Registration started. Check your email for a verification code."},
            status=status.HTTP_202_ACCEPTED,
        )


class RegisterVerifyCodeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        try:
            user = complete_registration(
                request.data.get("email", ""), request.data.get("code", "")
            )
        except Exception as exc:  # noqa: BLE001
            return validation_error_response(exc)
        send_registration_welcome(user)
        return Response(auth_payload(user, "Registration complete."))


class RegisterResendCodeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        email = normalize_email(request.data.get("email", ""))
        contact = (
            ContactEmail.objects.select_related("member")
            .filter(email_address__iexact=email)
            .first()
        )
        if contact is None or contact.member.is_active:
            return Response({"detail": "Unable to resend registration code."}, status=400)
        try:
            issued = issue_email_challenge(
                member=contact.member,
                purpose=EmailAuthChallenge.Purpose.REGISTER,
                target_email=email,
            )
        except EmailDeliveryError as exc:
            return validation_error_response(exc)
        data = {"message": "Verification code sent."}
        return Response(maybe_debug_code(data, issued), status=202)


class LoginView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        try:
            user = login_with_password(
                request.data.get("email", ""),
                request.data.get("password", ""),
                request=request,
            )
        except Exception as exc:  # noqa: BLE001
            return validation_error_response(exc)
        send_login_alert(user, request=request, method="password")
        return Response(auth_payload(user, "Login successful."))


class LoginRequestCodeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        email = normalize_email(request.data.get("email", ""))
        contact = (
            ContactEmail.objects.select_related("member")
            .filter(email_address__iexact=email, verified=True, member__is_active=True)
            .first()
        )
        if contact is None:
            return Response({"detail": "If the account exists, a code has been sent."}, status=202)
        try:
            issued = issue_email_challenge(
                member=contact.member,
                purpose=EmailAuthChallenge.Purpose.LOGIN,
                target_email=email,
            )
        except EmailDeliveryError as exc:
            return validation_error_response(exc)
        data = {"message": "Verification code sent."}
        return Response(maybe_debug_code(data, issued), status=202)


class LoginVerifyCodeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        try:
            challenge = verify_email_challenge(
                email=request.data.get("email", ""),
                code=request.data.get("code", ""),
                purpose=EmailAuthChallenge.Purpose.LOGIN,
            )
        except Exception as exc:  # noqa: BLE001
            return validation_error_response(exc)
        if not challenge.member.is_active:
            return Response({"detail": "Account is inactive."}, status=400)
        send_login_alert(challenge.member, request=request, method="email verification code")
        return Response(auth_payload(challenge.member, "Login successful."))


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        refresh = request.data.get("refresh")
        if refresh:
            try:
                RefreshToken(refresh).blacklist()
            except TokenError:
                pass
        return Response({"message": "Logged out."})


class RefreshView(TokenRefreshView):
    permission_classes = [AllowAny]
    authentication_classes = []


class ProfileView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({"user": user_payload(request.user)})

    def put(self, request):
        user = request.user
        user.first_name = str(
            request.data.get("first_name", request.data.get("firstName", user.first_name))
        ).strip()
        user.last_name = str(
            request.data.get("last_name", request.data.get("lastName", user.last_name))
        ).strip()
        user.organization = str(request.data.get("organization", user.organization)).strip()
        user.title = str(request.data.get("title", user.title)).strip()
        user.profile_image = str(
            request.data.get("imageUrl", user.profile_image or "") or ""
        ).strip()
        user.save(
            update_fields=["first_name", "last_name", "organization", "title", "profile_image"]
        )
        return Response({"user": user_payload(user)})


class AccountEmailsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        emails = [
            {
                "id": str(email.pk),
                "email": email.email_address,
                "type": email.email_type,
                "verified": email.verified,
                "subscribe": email.subscribe,
            }
            for email in request.user.contact_emails.all()
        ]
        return Response({"emails": emails})

    def post(self, request):
        email = normalize_email(request.data.get("email", ""))
        if not email:
            return Response({"email": "Email is required."}, status=400)
        contact, created = ContactEmail.objects.get_or_create(
            email_address=email,
            defaults={
                "member": request.user,
                "email_type": "secondary",
                "verified": False,
                "subscribe": True,
            },
        )
        if not created and contact.member_id != request.user.pk:
            return Response({"email": "This email address is already in use."}, status=400)
        try:
            issued = issue_email_challenge(
                member=request.user,
                purpose=EmailAuthChallenge.Purpose.CONTACT_EMAIL_VERIFY,
                target_email=email,
            )
        except EmailDeliveryError as exc:
            return validation_error_response(exc)
        data = {
            "email": {
                "id": str(contact.pk),
                "email": contact.email_address,
                "verified": contact.verified,
            }
        }
        return Response(maybe_debug_code(data, issued), status=201 if created else 200)


class PasswordResetRequestView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        email = normalize_email(request.data.get("email", ""))
        contact = (
            ContactEmail.objects.select_related("member")
            .filter(email_address__iexact=email, verified=True, member__is_active=True)
            .first()
        )
        if contact is not None:
            try:
                issued = issue_email_challenge(
                    member=contact.member,
                    purpose=EmailAuthChallenge.Purpose.PASSWORD_RESET,
                    target_email=email,
                )
            except EmailDeliveryError as exc:
                return validation_error_response(exc)
            data = {"message": "If the account exists, a reset code has been sent."}
            return Response(maybe_debug_code(data, issued), status=202)
        return Response(
            {"message": "If the account exists, a reset code has been sent."}, status=202
        )


class PasswordResetConfirmView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        try:
            challenge = verify_email_challenge(
                email=request.data.get("email", ""),
                code=request.data.get("code", ""),
                purpose=EmailAuthChallenge.Purpose.PASSWORD_RESET,
            )
            password = validate_password_pair(request.data)
        except Exception as exc:  # noqa: BLE001
            return validation_error_response(exc)

        member = challenge.member
        member.set_password(password)
        member.save(update_fields=["password"])
        return Response({"message": "Password reset complete."})


class ChangePasswordView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not request.user.check_password(request.data.get("current_password", "")):
            return Response({"current_password": "Current password is incorrect."}, status=400)
        try:
            password = validate_password_pair(request.data, password_key="new_password")
        except Exception as exc:  # noqa: BLE001
            return validation_error_response(exc)
        request.user.set_password(password)
        request.user.save(update_fields=["password"])
        return Response({"message": "Password changed."})


class DeleteAccountView(APIView):
    permission_classes = [IsAuthenticated]

    @transaction.atomic
    def post(self, request):
        user = request.user
        refresh = request.data.get("refresh")
        if refresh:
            try:
                RefreshToken(refresh).blacklist()
            except TokenError:
                pass
        user.is_active = False
        user.email = ""
        user.set_unusable_password()
        user.save(update_fields=["is_active", "email", "password"])
        ContactEmail.objects.filter(member=user).update(verified=False, subscribe=False)
        return Response({"message": "Account deleted."})


class PhoneAuthRequestCodeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        return Response(
            {"detail": "Phone authentication is not configured for this deployment."},
            status=status.HTTP_501_NOT_IMPLEMENTED,
        )


class PhoneAuthVerifyCodeView(PhoneAuthRequestCodeView):
    pass


class ContactPhonesView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        phones = [
            {
                "id": str(phone.pk),
                "phone": phone.to_e164(),
                "region": phone.region,
                "verified": phone.verified,
                "subscribe": phone.subscribe,
            }
            for phone in request.user.contact_phones.all()
        ]
        return Response({"phones": phones})

    def post(self, request):
        phone_number = ContactPhone.to_national_digits(
            str(request.data.get("phone", request.data.get("phone_number", ""))),
            str(request.data.get("region", "1-US")),
        )
        if not phone_number:
            return Response({"phone": "Phone number is required."}, status=400)
        phone, created = ContactPhone.objects.get_or_create(
            phone_number=phone_number,
            defaults={"member": request.user, "region": request.data.get("region", "1-US")},
        )
        if not created and phone.member_id != request.user.pk:
            return Response({"phone": "This phone number is already in use."}, status=400)
        return Response(
            {
                "phone": {
                    "id": str(phone.pk),
                    "phone": phone.to_e164(),
                    "verified": phone.verified,
                }
            },
            status=201 if created else 200,
        )
