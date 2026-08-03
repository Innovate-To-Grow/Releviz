import uuid

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError

from apps.authn.models import AuthSession, ContactEmail, ContactPhone, EmailAuthChallenge
from apps.authn.security import AuthRateThrottle, enforce_cookie_request_origin
from apps.authn.services import (
    active_keypair,
    complete_registration,
    decrypt_password,
    delete_member_account,
    issue_auth_session,
    issue_email_challenge,
    login_with_password,
    normalize_email,
    revoke_all_auth_sessions,
    revoke_auth_session,
    revoke_refresh_session,
    rotate_auth_session,
    send_login_alert,
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


def _harden_auth_response(response):
    response["Cache-Control"] = "no-store"
    response["Pragma"] = "no-cache"
    return response


def _set_refresh_cookie(response, refresh_token: str):
    response.set_cookie(
        settings.AUTH_REFRESH_COOKIE_NAME,
        refresh_token,
        max_age=int(settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"].total_seconds()),
        httponly=True,
        secure=settings.AUTH_REFRESH_COOKIE_SECURE,
        samesite=settings.AUTH_REFRESH_COOKIE_SAMESITE,
        path=settings.AUTH_REFRESH_COOKIE_PATH,
    )
    return _harden_auth_response(response)


def _clear_refresh_cookie(response):
    response.delete_cookie(
        settings.AUTH_REFRESH_COOKIE_NAME,
        path=settings.AUTH_REFRESH_COOKIE_PATH,
        samesite=settings.AUTH_REFRESH_COOKIE_SAMESITE,
    )
    return _harden_auth_response(response)


def authenticated_response(user, message: str, request, *, login_alert_method: str = ""):
    with transaction.atomic():
        issued = issue_auth_session(user, message, request=request)
        if login_alert_method:
            send_login_alert(
                user,
                request=request,
                method=login_alert_method,
                auth_session=issued.session,
            )
    return _set_refresh_cookie(Response(issued.payload), issued.refresh_token)


class PublicAuthView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [AuthRateThrottle]


class PublicKeyView(PublicAuthView):
    def get(self, request):
        key = active_keypair()
        return Response(
            {
                "key_id": str(key.key_id),
                "public_key": key.public_key_pem,
                "password_encryption_required": bool(settings.REQUIRE_ENCRYPTED_PASSWORDS),
            }
        )


class RegisterView(PublicAuthView):
    auth_rate_scope = "register"

    def post(self, request):
        try:
            start_registration(request.data)
        except Exception as exc:  # noqa: BLE001
            return validation_error_response(exc)
        return Response(
            {"message": "Registration started. Check your email for a verification code."},
            status=status.HTTP_202_ACCEPTED,
        )


class RegisterVerifyCodeView(PublicAuthView):
    auth_rate_scope = "code_verify"

    def post(self, request):
        try:
            user = complete_registration(
                request.data.get("email", ""), request.data.get("code", "")
            )
        except Exception as exc:  # noqa: BLE001
            return validation_error_response(exc)
        return authenticated_response(user, "Registration complete.", request)


class RegisterResendCodeView(PublicAuthView):
    auth_rate_scope = "code_request"

    def post(self, request):
        email = normalize_email(request.data.get("email", ""))
        contact = (
            ContactEmail.objects.select_related("member")
            .filter(email_address__iexact=email)
            .first()
        )
        has_registration = bool(
            contact
            and contact.member.email_auth_challenges.filter(
                purpose=EmailAuthChallenge.Purpose.REGISTER,
            ).exists()
        )
        if contact is None or contact.verified or not has_registration:
            return Response(
                {"message": "If registration is pending, a verification code has been sent."},
                status=202,
            )
        issued = issue_email_challenge(
            member=contact.member,
            purpose=EmailAuthChallenge.Purpose.REGISTER,
            target_email=email,
        )
        data = {"message": "If registration is pending, a verification code has been sent."}
        return Response(maybe_debug_code(data, issued), status=202)


class LoginView(PublicAuthView):
    auth_rate_scope = "password_login"

    def post(self, request):
        try:
            password = decrypt_password(
                request.data.get("password", ""),
                request.data.get("key_id", ""),
            )
            user = login_with_password(
                request.data.get("email", ""),
                password,
                request=request,
            )
        except Exception as exc:  # noqa: BLE001
            return validation_error_response(exc)
        return authenticated_response(
            user,
            "Login successful.",
            request,
            login_alert_method="password",
        )


class LoginRequestCodeView(PublicAuthView):
    auth_rate_scope = "code_request"

    def post(self, request):
        email = normalize_email(request.data.get("email", ""))
        generic_data = {"message": "If the account exists, a code has been sent."}
        contact = (
            ContactEmail.objects.select_related("member")
            .filter(
                email_address__iexact=email,
                verified=True,
                member__is_active=True,
                member__access_level="full",
            )
            .first()
        )
        if contact is None:
            return Response(generic_data, status=202)
        issued = issue_email_challenge(
            member=contact.member,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email=email,
        )
        return Response(maybe_debug_code(generic_data, issued), status=202)


class LoginVerifyCodeView(PublicAuthView):
    auth_rate_scope = "code_verify"

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
        return authenticated_response(
            challenge.member,
            "Login successful.",
            request,
            login_alert_method="email verification code",
        )


class LogoutView(PublicAuthView):
    auth_rate_scope = "refresh"

    def post(self, request):
        enforce_cookie_request_origin(request)
        refresh = request.COOKIES.get(settings.AUTH_REFRESH_COOKIE_NAME, "")
        revoke_refresh_session(refresh, "logout")
        return _clear_refresh_cookie(Response({"message": "Logged out."}))


class RefreshView(PublicAuthView):
    auth_rate_scope = "refresh"

    def post(self, request):
        enforce_cookie_request_origin(request)
        raw_refresh = request.COOKIES.get(settings.AUTH_REFRESH_COOKIE_NAME, "")
        try:
            issued = rotate_auth_session(raw_refresh, request=request)
        except TokenError:
            return _clear_refresh_cookie(
                Response(
                    {"detail": "Session is not available."},
                    status=status.HTTP_401_UNAUTHORIZED,
                )
            )
        return _set_refresh_cookie(Response(issued.payload), issued.refresh_token)


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


class AuthSessionsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        current_id = str(request.auth.get("session_id", ""))
        sessions = request.user.auth_sessions.filter(
            revoked_at__isnull=True,
            expires_at__gt=timezone.now(),
        )
        return Response(
            {
                "sessions": [
                    {
                        "id": str(session.pk),
                        "createdAt": session.created_at.isoformat(),
                        "lastSeenAt": session.last_seen_at.isoformat(),
                        "expiresAt": session.expires_at.isoformat(),
                        "ipAddress": session.ip_address,
                        "userAgent": session.user_agent,
                        "current": str(session.pk) == current_id,
                    }
                    for session in sessions
                ]
            }
        )

    def delete(self, request):
        current_id = str(request.auth.get("session_id", ""))
        if request.data.get("all"):
            count = revoke_all_auth_sessions(
                request.user,
                AuthSession.RevocationReason.SESSION_REVOKE,
            )
            return _clear_refresh_cookie(Response({"revoked": count, "currentRevoked": True}))

        raw_session_id = request.data.get("sessionId", "")
        try:
            session_id = uuid.UUID(str(raw_session_id))
        except (TypeError, ValueError, AttributeError):
            return Response({"sessionId": "A valid session ID is required."}, status=400)
        session = revoke_auth_session(
            request.user,
            session_id,
            AuthSession.RevocationReason.SESSION_REVOKE,
        )
        if session is None:
            return Response({"detail": "Session not found."}, status=404)
        current_revoked = str(session.pk) == current_id
        response = Response({"revoked": 1, "currentRevoked": current_revoked})
        return _clear_refresh_cookie(response) if current_revoked else response


class AccountEmailsView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [AuthRateThrottle]
    auth_rate_scope = "code_request"
    auth_rate_methods = {"POST"}

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
        issued = issue_email_challenge(
            member=request.user,
            purpose=EmailAuthChallenge.Purpose.CONTACT_EMAIL_VERIFY,
            target_email=email,
        )
        data = {
            "email": {
                "id": str(contact.pk),
                "email": contact.email_address,
                "verified": contact.verified,
            }
        }
        return Response(maybe_debug_code(data, issued), status=201 if created else 200)


class PasswordResetRequestView(PublicAuthView):
    auth_rate_scope = "code_request"

    def post(self, request):
        email = normalize_email(request.data.get("email", ""))
        contact = (
            ContactEmail.objects.select_related("member")
            .filter(
                email_address__iexact=email,
                verified=True,
                member__is_active=True,
                member__access_level="full",
            )
            .first()
        )
        if contact is not None:
            issued = issue_email_challenge(
                member=contact.member,
                purpose=EmailAuthChallenge.Purpose.PASSWORD_RESET,
                target_email=email,
            )
            data = {"message": "If the account exists, a reset code has been sent."}
            return Response(maybe_debug_code(data, issued), status=202)
        return Response(
            {"message": "If the account exists, a reset code has been sent."}, status=202
        )


class PasswordResetConfirmView(PublicAuthView):
    auth_rate_scope = "code_verify"

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
        revoke_all_auth_sessions(member, "password_reset")
        return Response({"message": "Password reset complete."})


class ChangePasswordView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        try:
            current_password = decrypt_password(
                request.data.get("current_password", ""),
                request.data.get("key_id", ""),
            )
        except Exception as exc:  # noqa: BLE001
            return validation_error_response(exc)
        if not request.user.check_password(current_password):
            return Response({"current_password": "Current password is incorrect."}, status=400)
        try:
            password = validate_password_pair(request.data, password_key="new_password")
        except Exception as exc:  # noqa: BLE001
            return validation_error_response(exc)
        request.user.set_password(password)
        request.user.save(update_fields=["password"])
        revoke_all_auth_sessions(request.user, "password_change")
        return _clear_refresh_cookie(
            Response({"message": "Password changed. Please log in again."})
        )


class DeleteAccountView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        user = request.user
        try:
            password = decrypt_password(
                request.data.get("password", ""),
                request.data.get("key_id", ""),
            )
        except Exception as exc:  # noqa: BLE001
            return validation_error_response(exc)
        if not user.check_password(password):
            return Response({"password": "Current password is incorrect."}, status=400)
        if request.data.get("confirmation") != "DELETE":
            return Response(
                {"confirmation": 'Type "DELETE" to confirm account deletion.'},
                status=400,
            )
        delete_member_account(user)
        return _clear_refresh_cookie(Response({"message": "Account deleted."}))


class PhoneAuthRequestCodeView(PublicAuthView):
    auth_rate_scope = "code_request"

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
