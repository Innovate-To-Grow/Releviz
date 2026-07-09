import base64
import secrets
from dataclasses import dataclass

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from django.conf import settings
from django.contrib.auth import authenticate, get_user_model
from django.contrib.auth.hashers import check_password, make_password
from django.db import transaction
from django.utils import timezone
from rest_framework import serializers
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.models import ContactEmail, EmailAuthChallenge, RSAKeypair
from apps.messaging.models import EmailMessageLog
from apps.messaging.services import EmailDeliveryError, send_email_message


def normalize_email(email: str) -> str:
    return str(email or "").strip().lower()


def user_payload(user) -> dict:
    primary_email = user.get_primary_contact_email()
    return {
        "id": str(user.pk),
        "email": primary_email,
        "displayName": user.display_name(),
        "firstName": user.first_name,
        "lastName": user.last_name,
        "organization": user.organization,
        "title": user.title,
        "imageUrl": user.profile_image or None,
        "isStaff": bool(user.is_staff),
    }


def auth_payload(user, message: str = "Authenticated.") -> dict:
    refresh = RefreshToken.for_user(user)
    return {
        "message": message,
        "access": str(refresh.access_token),
        "refresh": str(refresh),
        "user": user_payload(user),
    }


def active_keypair() -> RSAKeypair:
    key = RSAKeypair.objects.filter(is_active=True).first()
    if key:
        return key
    return RSAKeypair.objects.create()


def decrypt_password(value: str, key_id: str = "") -> str:
    if not getattr(settings, "REQUIRE_ENCRYPTED_PASSWORDS", False):
        return value

    if not value:
        raise serializers.ValidationError("Password is required.")

    key = (
        RSAKeypair.objects.filter(key_id=key_id, is_active=True).first()
        if key_id
        else active_keypair()
    )
    try:
        private_key = serialization.load_pem_private_key(
            key.private_key_pem.encode("utf-8"),
            password=None,
        )
        encrypted = base64.b64decode(value)
        return private_key.decrypt(
            encrypted,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        ).decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        raise serializers.ValidationError("Unable to decrypt password.") from exc


def validate_password_pair(data: dict, *, password_key: str = "password") -> str:
    password = decrypt_password(data.get(password_key, ""), data.get("key_id", ""))
    confirm_raw = data.get(f"{password_key}_confirm", data.get("password_confirm", password))
    confirm = decrypt_password(confirm_raw, data.get("key_id", ""))
    if password != confirm:
        raise serializers.ValidationError({"password_confirm": "Passwords do not match."})
    if len(password) < 8:
        raise serializers.ValidationError({"password": "Password must be at least 8 characters."})
    return password


@dataclass
class IssuedChallenge:
    challenge: EmailAuthChallenge
    code: str


def issue_email_challenge(
    *,
    member,
    purpose: str,
    target_email: str,
    channel: str = EmailAuthChallenge.Channel.EMAIL,
    target_phone: str = "",
) -> IssuedChallenge:
    code = f"{secrets.randbelow(1_000_000):06d}"
    now = timezone.now()
    EmailAuthChallenge.objects.filter(
        member=member,
        purpose=purpose,
        status=EmailAuthChallenge.Status.PENDING,
    ).update(status=EmailAuthChallenge.Status.EXPIRED)
    challenge = EmailAuthChallenge.objects.create(
        member=member,
        purpose=purpose,
        channel=channel,
        target_email=normalize_email(target_email),
        target_phone=target_phone,
        code_hash=make_password(code),
        expires_at=EmailAuthChallenge.default_expiry(),
        last_sent_at=now,
    )
    if channel == EmailAuthChallenge.Channel.EMAIL:
        send_email_message(
            subject="Your Releviz verification code",
            body=f"Your Releviz verification code is {code}. It expires in 10 minutes.",
            recipients=[target_email],
            message_type=EmailMessageLog.MessageType.VERIFICATION,
        )
    return IssuedChallenge(challenge=challenge, code=code)


def _request_context(request) -> tuple[str, str]:
    if request is None:
        return "Unknown", "Unknown"
    forwarded_for = str(request.META.get("HTTP_X_FORWARDED_FOR", "")).split(",")[0].strip()
    ip_address = forwarded_for or str(request.META.get("REMOTE_ADDR", "") or "Unknown")
    user_agent = str(request.META.get("HTTP_USER_AGENT", "") or "Unknown").strip() or "Unknown"
    if len(user_agent) > 160:
        user_agent = f"{user_agent[:157]}..."
    return ip_address, user_agent


def _send_best_effort_account_email(
    *,
    user,
    subject: str,
    body: str,
    message_type: str,
) -> bool:
    recipient = normalize_email(user.get_primary_contact_email())
    if not recipient:
        return False
    try:
        send_email_message(
            subject=subject,
            body=body,
            recipients=[recipient],
            message_type=message_type,
        )
    except EmailDeliveryError:
        return False
    return True


def send_registration_welcome(user) -> bool:
    body = (
        f"Welcome to Releviz, {user.display_name()}.\n\n"
        "Your account is ready. You can now create events, invite participants, "
        "and manage your scheduling dashboard."
    )
    return _send_best_effort_account_email(
        user=user,
        subject="Welcome to Releviz",
        body=body,
        message_type=EmailMessageLog.MessageType.WELCOME,
    )


def send_login_alert(user, *, request=None, method: str = "password") -> bool:
    ip_address, user_agent = _request_context(request)
    login_time = timezone.now().isoformat()
    body = (
        "A new login was completed for your Releviz account.\n\n"
        f"Account: {user.get_primary_contact_email()}\n"
        f"Time: {login_time}\n"
        f"Method: {method}\n"
        f"IP address: {ip_address}\n"
        f"User agent: {user_agent}\n\n"
        "If this was not you, change your password and contact support."
    )
    return _send_best_effort_account_email(
        user=user,
        subject="New login to your Releviz account",
        body=body,
        message_type=EmailMessageLog.MessageType.LOGIN_ALERT,
    )


def verify_email_challenge(*, email: str, code: str, purpose: str, consume: bool = True):
    normalized = normalize_email(email)
    challenge = (
        EmailAuthChallenge.objects.select_related("member")
        .filter(
            target_email__iexact=normalized,
            purpose=purpose,
            status=EmailAuthChallenge.Status.PENDING,
        )
        .order_by("-created_at")
        .first()
    )
    if challenge is None:
        raise serializers.ValidationError({"code": "Invalid or expired verification code."})
    if challenge.is_expired:
        challenge.status = EmailAuthChallenge.Status.EXPIRED
        challenge.save(update_fields=["status", "updated_at"])
        raise serializers.ValidationError({"code": "Invalid or expired verification code."})
    if challenge.attempts >= challenge.max_attempts:
        challenge.status = EmailAuthChallenge.Status.EXPIRED
        challenge.save(update_fields=["status", "updated_at"])
        raise serializers.ValidationError({"code": "Too many verification attempts."})
    if not check_password(str(code or ""), challenge.code_hash):
        challenge.attempts += 1
        challenge.save(update_fields=["attempts", "updated_at"])
        raise serializers.ValidationError({"code": "Invalid or expired verification code."})

    challenge.mark_verified()
    if consume:
        challenge.mark_consumed()
    return challenge


@transaction.atomic
def start_registration(data: dict):
    email = normalize_email(data.get("email", ""))
    password = validate_password_pair(data)
    first_name = str(data.get("first_name") or data.get("firstName") or "").strip()
    last_name = str(data.get("last_name") or data.get("lastName") or "").strip()
    organization = str(data.get("organization") or "").strip()
    title = str(data.get("title") or "").strip()

    if not email:
        raise serializers.ValidationError({"email": "Email is required."})
    if not first_name:
        raise serializers.ValidationError({"first_name": "First name is required."})
    if not last_name:
        raise serializers.ValidationError({"last_name": "Last name is required."})

    verified_contact = ContactEmail.objects.filter(
        email_address__iexact=email, verified=True
    ).first()
    if verified_contact:
        raise serializers.ValidationError({"email": "Unable to register with this email address."})

    contact = (
        ContactEmail.objects.select_related("member").filter(email_address__iexact=email).first()
    )
    member = contact.member if contact else None
    Member = get_user_model()
    if member is None:
        member = Member.objects.create_user(
            password=password,
            first_name=first_name,
            last_name=last_name,
            organization=organization,
            title=title,
            is_active=False,
            email=email,
        )
    else:
        member.first_name = first_name
        member.last_name = last_name
        member.organization = organization
        member.title = title
        member.email = email
        member.is_active = False
        member.set_password(password)
        member.save()

    if contact is None:
        ContactEmail.objects.create(
            member=member,
            email_address=email,
            email_type="primary",
            verified=False,
        )
    else:
        contact.member = member
        contact.email_type = "primary"
        contact.save(update_fields=["member", "email_type", "updated_at"])

    issue_email_challenge(
        member=member,
        purpose=EmailAuthChallenge.Purpose.REGISTER,
        target_email=email,
    )
    return member


@transaction.atomic
def complete_registration(email: str, code: str):
    challenge = verify_email_challenge(
        email=email,
        code=code,
        purpose=EmailAuthChallenge.Purpose.REGISTER,
    )
    member = challenge.member
    member.is_active = True
    member.email = normalize_email(email)
    member.save(update_fields=["is_active", "email"])
    ContactEmail.objects.filter(member=member, email_address__iexact=email).update(
        verified=True,
        email_type="primary",
    )
    return member


def login_with_password(email: str, password: str, request=None):
    user = authenticate(request=request, username=normalize_email(email), password=password)
    if user is None:
        raise serializers.ValidationError({"detail": "Invalid email or password."})
    return user
