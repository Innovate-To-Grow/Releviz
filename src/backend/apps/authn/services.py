import base64
import hashlib
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from django.conf import settings
from django.contrib.auth import authenticate, get_user_model
from django.contrib.auth.hashers import check_password, make_password
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework import serializers
from rest_framework_simplejwt.exceptions import TokenBackendError, TokenError
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.state import token_backend
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.utils import get_md5_hash_password

from apps.authn.models import (
    AuthSession,
    ContactEmail,
    ContactPhone,
    EmailAuthChallenge,
    RSAKeypair,
)
from apps.authn.security import (
    clear_password_login_failures,
    client_ip,
    password_login_allowed,
    record_password_login_failure,
    request_user_agent,
    security_log_key,
)
from apps.messaging.email_templates import render_branded_email
from apps.messaging.models import EmailDeliveryJob, EmailMessageLog
from apps.messaging.services import dispatch_email_job, enqueue_email_job, frontend_url

logger = logging.getLogger("releviz.security")


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


@dataclass(frozen=True)
class IssuedAuthSession:
    payload: dict
    refresh_token: str
    session: AuthSession


def _datetime_from_token(token, claim: str) -> datetime:
    return datetime.fromtimestamp(int(token[claim]), tz=UTC)


def _issued_session_payload(
    user,
    message: str,
    refresh: RefreshToken,
    session: AuthSession,
) -> dict:
    access = refresh.access_token
    return {
        "message": message,
        "access": str(access),
        "accessExpiresAt": _datetime_from_token(access, "exp").isoformat(),
        "session": {
            "id": str(session.pk),
            "expiresAt": session.expires_at.isoformat(),
        },
        "user": user_payload(user),
    }


@transaction.atomic
def issue_auth_session(
    user,
    message: str = "Authenticated.",
    *,
    request=None,
) -> IssuedAuthSession:
    if not user.is_active:
        raise serializers.ValidationError({"detail": "Account is inactive."})
    now = timezone.now()
    session = AuthSession(
        member=user,
        expires_at=now + settings.AUTH_SESSION_ABSOLUTE_LIFETIME,
        last_seen_at=now,
        ip_address=client_ip(request) if request is not None else None,
        user_agent=request_user_agent(request) if request is not None else "",
    )
    refresh = RefreshToken.for_user(user)
    refresh["session_id"] = str(session.pk)
    session.refresh_jti = str(refresh[api_settings.JTI_CLAIM])
    session.save()
    OutstandingToken.objects.filter(jti=session.refresh_jti).update(token=str(refresh))
    logger.info(
        "auth_session_issued",
        extra={"member_id": str(user.pk), "auth_session_id": str(session.pk)},
    )
    return IssuedAuthSession(
        payload=_issued_session_payload(user, message, refresh, session),
        refresh_token=str(refresh),
        session=session,
    )


def auth_payload(user, message: str = "Authenticated.") -> dict:
    return issue_auth_session(user, message).payload


def _validated_refresh_ignoring_blacklist(raw_refresh: str) -> RefreshToken:
    try:
        token_backend.decode(raw_refresh, verify=True)
    except TokenBackendError as exc:
        raise TokenError("Refresh credential is invalid.") from exc
    refresh = RefreshToken(raw_refresh, verify=False)
    refresh.verify_token_type()
    return refresh


def _recover_refresh_rotation(
    session: AuthSession,
    presented_refresh: RefreshToken,
    *,
    request,
    now,
) -> IssuedAuthSession | None:
    if (
        request is None
        or str(presented_refresh.get(api_settings.JTI_CLAIM, "")) != session.previous_refresh_jti
        or session.refresh_recovery_expires_at is None
        or session.refresh_recovery_expires_at <= now
        or session.refresh_recovered_at is not None
        or session.ip_address != client_ip(request)
        or session.user_agent != request_user_agent(request)
    ):
        return None
    outstanding = OutstandingToken.objects.filter(
        jti=session.refresh_jti,
        user=session.member,
    ).first()
    if outstanding is None or not outstanding.token:
        return None
    current_refresh = RefreshToken(outstanding.token)
    if current_refresh.get("session_id") != str(session.pk):
        return None
    session.refresh_recovered_at = now
    session.last_seen_at = now
    session.save(
        update_fields=[
            "refresh_recovered_at",
            "last_seen_at",
            "updated_at",
        ]
    )
    logger.warning(
        "auth_refresh_rotation_recovered",
        extra={
            "member_id": str(session.member_id),
            "auth_session_id": str(session.pk),
        },
    )
    return IssuedAuthSession(
        payload=_issued_session_payload(
            session.member,
            "Session refresh recovered.",
            current_refresh,
            session,
        ),
        refresh_token=outstanding.token,
        session=session,
    )


@transaction.atomic
def rotate_auth_session(raw_refresh: str, *, request=None) -> IssuedAuthSession:
    if not raw_refresh:
        raise TokenError("Refresh credential is missing.")
    try:
        refresh = RefreshToken(raw_refresh)
    except TokenError:
        refresh = _validated_refresh_ignoring_blacklist(raw_refresh)
    session_id = refresh.get("session_id")
    session = (
        AuthSession.objects.select_for_update()
        .select_related("member")
        .filter(pk=session_id)
        .first()
    )
    now = timezone.now()
    if (
        session is None
        or session.revoked_at is not None
        or session.expires_at <= now
        or str(refresh.get(api_settings.USER_ID_CLAIM, "")) != str(session.member_id)
    ):
        raise TokenError("Refresh credential is no longer active.")
    user = session.member
    if not user.is_active:
        raise TokenError("Account is inactive.")
    if api_settings.CHECK_REVOKE_TOKEN and refresh.get(
        api_settings.REVOKE_TOKEN_CLAIM
    ) != get_md5_hash_password(user.password):
        raise TokenError("Account credentials changed.")

    presented_jti = str(refresh.get(api_settings.JTI_CLAIM, ""))
    if presented_jti != session.refresh_jti:
        recovered = _recover_refresh_rotation(
            session,
            refresh,
            request=request,
            now=now,
        )
        if recovered is not None:
            return recovered
        raise TokenError("Refresh credential is no longer active.")

    refresh.blacklist()
    next_refresh = RefreshToken.for_user(user)
    next_refresh["session_id"] = str(session.pk)
    session.previous_refresh_jti = presented_jti
    session.refresh_jti = str(next_refresh[api_settings.JTI_CLAIM])
    session.refresh_recovery_expires_at = now + settings.AUTH_REFRESH_RETRY_GRACE
    session.refresh_recovered_at = None
    session.last_seen_at = now
    if request is not None:
        session.ip_address = client_ip(request)
        session.user_agent = request_user_agent(request)
    session.save(
        update_fields=[
            "refresh_jti",
            "previous_refresh_jti",
            "refresh_recovery_expires_at",
            "refresh_recovered_at",
            "last_seen_at",
            "ip_address",
            "user_agent",
            "updated_at",
        ]
    )
    OutstandingToken.objects.filter(jti=session.refresh_jti).update(token=str(next_refresh))
    logger.info(
        "auth_session_rotated",
        extra={"member_id": str(user.pk), "auth_session_id": str(session.pk)},
    )
    return IssuedAuthSession(
        payload=_issued_session_payload(user, "Session refreshed.", next_refresh, session),
        refresh_token=str(next_refresh),
        session=session,
    )


@transaction.atomic
def revoke_refresh_session(raw_refresh: str, reason: str) -> bool:
    if not raw_refresh:
        return False
    try:
        refresh = RefreshToken(raw_refresh, verify=False)
    except TokenError:
        return False
    session_id = refresh.get("session_id")
    session = AuthSession.objects.select_for_update().filter(pk=session_id).first()
    revoked = session.revoke(reason) if session is not None else False
    try:
        refresh.blacklist()
    except TokenError:
        pass
    if revoked:
        logger.info(
            "auth_session_revoked",
            extra={"auth_session_id": str(session.pk), "revocation_reason": reason},
        )
    return revoked


def revoke_all_auth_sessions(user, reason: str) -> int:
    count = AuthSession.objects.filter(member=user, revoked_at__isnull=True).update(
        revoked_at=timezone.now(),
        revoked_reason=reason,
        updated_at=timezone.now(),
    )
    outstanding = OutstandingToken.objects.filter(
        user=user,
        blacklistedtoken__isnull=True,
    )
    BlacklistedToken.objects.bulk_create(
        [BlacklistedToken(token=token) for token in outstanding],
        ignore_conflicts=True,
    )
    logger.info(
        "auth_sessions_revoked",
        extra={"member_id": str(user.pk), "revocation_reason": reason, "session_count": count},
    )
    return count


@transaction.atomic
def delete_member_account(user) -> None:
    from apps.messaging.models import EmailDeliveryJob, EmailDeliveryRequest
    from apps.scheduling.models import EventInvitation, FinalMeeting, Participant

    member = get_user_model().objects.select_for_update().get(pk=user.pk)
    member_id = str(member.pk)
    contact_emails = {
        normalize_email(value)
        for value in ContactEmail.objects.filter(member=member).values_list(
            "email_address", flat=True
        )
        if normalize_email(value)
    }
    if normalize_email(member.email):
        contact_emails.add(normalize_email(member.email))

    revoke_all_auth_sessions(member, AuthSession.RevocationReason.ACCOUNT_DELETE)

    auth_jobs = EmailDeliveryJob.objects.filter(member=member)
    auth_job_ids = list(auth_jobs.values_list("pk", flat=True))
    related_logs = Q(delivery_job_id__in=auth_job_ids)
    if contact_emails:
        related_logs |= Q(recipient__in=contact_emails)
    EmailMessageLog.objects.filter(related_logs).update(recipient="deleted@invalid.example")
    auth_jobs.delete()
    EmailAuthChallenge.objects.filter(member=member).delete()

    if contact_emails:
        recipient_jobs = EmailDeliveryJob.objects.filter(recipient__in=contact_emails)
        recipient_jobs.filter(
            status__in=[
                EmailDeliveryJob.Status.PENDING,
                EmailDeliveryJob.Status.PROCESSING,
                EmailDeliveryJob.Status.RETRY,
            ]
        ).update(
            status=EmailDeliveryJob.Status.CANCELED,
            last_error="Recipient account was deleted.",
            locked_at=None,
            lock_token=None,
            updated_at=timezone.now(),
        )
        recipient_jobs.update(
            recipient="deleted@invalid.example",
            body="",
            html_body="",
            attachments=[],
            content_encrypted=False,
            updated_at=timezone.now(),
        )

    invitations = EventInvitation.objects.select_for_update().filter(
        Q(member=member) | Q(email__in=contact_emails)
    )
    for invitation in invitations:
        invitation.member = None
        invitation.email = f"deleted-{member.pk.hex[:12]}-{invitation.pk.hex[:12]}@invalid.example"
        invitation.save(update_fields=["member", "email", "updated_at"])
    EventInvitation.objects.filter(invited_by=member).update(invited_by=None)
    Participant.objects.filter(member=member).update(participant_name="Deleted participant")
    FinalMeeting.objects.filter(confirmed_by=member).update(confirmed_by=None)
    EmailDeliveryRequest.objects.filter(requested_by=member).update(requested_by=None)

    ContactEmail.objects.filter(member=member).delete()
    ContactPhone.objects.filter(member=member).delete()
    member.groups.clear()
    member.user_permissions.clear()
    member.is_active = False
    member.is_staff = False
    member.is_superuser = False
    member.email = ""
    member.first_name = ""
    member.middle_name = ""
    member.last_name = ""
    member.organization = ""
    member.title = ""
    member.profile_image = ""
    member.admin_apps = []
    member.last_login = None
    member.set_unusable_password()
    member.save(
        update_fields=[
            "is_active",
            "is_staff",
            "is_superuser",
            "email",
            "first_name",
            "middle_name",
            "last_name",
            "organization",
            "title",
            "profile_image",
            "admin_apps",
            "last_login",
            "password",
        ]
    )
    logger.info("account_deleted", extra={"member_id": member_id})


@transaction.atomic
def revoke_auth_session(user, session_id, reason: str):
    session = AuthSession.objects.select_for_update().filter(pk=session_id, member=user).first()
    if session is None:
        return None
    session.revoke(reason)
    outstanding = OutstandingToken.objects.filter(jti=session.refresh_jti).first()
    if outstanding is not None:
        BlacklistedToken.objects.get_or_create(token=outstanding)
    logger.info(
        "auth_session_revoked_by_user",
        extra={
            "member_id": str(user.pk),
            "auth_session_id": str(session.pk),
            "revocation_reason": reason,
        },
    )
    return session


def active_keypair() -> RSAKeypair:
    key = RSAKeypair.objects.filter(is_active=True).first()
    if key:
        return key
    return RSAKeypair.objects.create()


def decrypt_password(value: str, key_id: str = "") -> str:
    if not getattr(settings, "REQUIRE_ENCRYPTED_PASSWORDS", False) and not key_id:
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
    delivery_job: EmailDeliveryJob | None = None


def _dispatch_job_after_commit(job_id) -> None:
    transaction.on_commit(
        lambda job_id=job_id: dispatch_email_job(job_id),
        robust=True,
    )


def _cancel_auth_challenge_jobs(challenge_ids, reason: str) -> int:
    ids = list(challenge_ids)
    if not ids:
        return 0
    return EmailDeliveryJob.objects.filter(
        auth_challenge_id__in=ids,
        status__in=[
            EmailDeliveryJob.Status.PENDING,
            EmailDeliveryJob.Status.PROCESSING,
            EmailDeliveryJob.Status.RETRY,
        ],
    ).update(
        status=EmailDeliveryJob.Status.CANCELED,
        last_error=reason,
        locked_at=None,
        lock_token=None,
        updated_at=timezone.now(),
    )


@transaction.atomic
def issue_email_challenge(
    *,
    member,
    purpose: str,
    target_email: str,
    channel: str = EmailAuthChallenge.Channel.EMAIL,
    target_phone: str = "",
) -> IssuedChallenge:
    code = f"{secrets.randbelow(1_000_000):06d}"
    member = member.__class__.objects.select_for_update().get(pk=member.pk)
    pending_challenges = EmailAuthChallenge.objects.filter(
        member=member,
        purpose=purpose,
        status=EmailAuthChallenge.Status.PENDING,
    )
    pending_ids = list(pending_challenges.values_list("pk", flat=True))
    pending_challenges.update(status=EmailAuthChallenge.Status.EXPIRED)
    _cancel_auth_challenge_jobs(pending_ids, "Superseded by a newer authentication challenge.")
    normalized_target = normalize_email(target_email)
    challenge = EmailAuthChallenge.objects.create(
        member=member,
        purpose=purpose,
        channel=channel,
        target_email=normalized_target,
        target_phone=target_phone,
        code_hash=make_password(code),
        expires_at=EmailAuthChallenge.default_expiry(),
    )
    delivery_job = None
    if channel == EmailAuthChallenge.Channel.EMAIL:
        delivery_job, _created = enqueue_email_job(
            idempotency_key=f"auth-challenge:{challenge.pk}",
            subject="Your Releviz verification code",
            body=(
                f"Your Releviz verification code is {code}. It expires 10 minutes after delivery."
            ),
            html_body=render_branded_email(
                title="Your verification code",
                preheader="Use this code to continue with Releviz.",
                eyebrow="Account security",
                paragraphs=("Enter this code to finish verifying your email address.",),
                code=code,
                notice=(
                    "This code expires 10 minutes after delivery. If you did not request it, "
                    "you can safely ignore this email."
                ),
            ),
            recipient=normalized_target,
            message_type=EmailMessageLog.MessageType.VERIFICATION,
            message_id=f"<auth-challenge-{challenge.pk}@releviz.local>",
            member=member,
            auth_challenge=challenge,
            max_attempts=4,
            encrypt_content=True,
        )
        _dispatch_job_after_commit(delivery_job.pk)
    return IssuedChallenge(challenge=challenge, code=code, delivery_job=delivery_job)


def _request_context(request) -> tuple[str, str]:
    if request is None:
        return "Unknown", "Unknown"
    ip_address = client_ip(request)
    user_agent = request_user_agent(request) or "Unknown"
    if len(user_agent) > 160:
        user_agent = f"{user_agent[:157]}..."
    return ip_address, user_agent


def _enqueue_account_email(
    *,
    user,
    idempotency_key: str,
    message_id: str,
    subject: str,
    body: str,
    html_body: str,
    message_type: str,
    auth_session=None,
) -> bool:
    recipient = normalize_email(user.get_primary_contact_email())
    if not recipient:
        return False
    job, _created = enqueue_email_job(
        idempotency_key=idempotency_key,
        subject=subject,
        body=body,
        html_body=html_body,
        recipient=recipient,
        message_type=message_type,
        message_id=message_id,
        member=user,
        auth_session=auth_session,
        encrypt_content=True,
    )
    _dispatch_job_after_commit(job.pk)
    return True


def send_registration_welcome(user) -> bool:
    body = (
        f"Welcome to Releviz, {user.display_name()}.\n\n"
        "Your account is ready. You can now create events, invite participants, "
        "and manage your scheduling dashboard."
    )
    return _enqueue_account_email(
        user=user,
        idempotency_key=f"auth-welcome:{user.pk}",
        message_id=f"<auth-welcome-{user.pk}@releviz.local>",
        subject="Welcome to Releviz",
        body=body,
        html_body=render_branded_email(
            title="Welcome to Releviz",
            preheader="Your account is ready.",
            greeting=f"Welcome, {user.display_name()}.",
            paragraphs=(
                "Your account is ready. You can now create events, invite participants, "
                "and manage your scheduling dashboard.",
            ),
            cta_label="Open your dashboard",
            cta_url=frontend_url("/dashboard"),
        ),
        message_type=EmailMessageLog.MessageType.WELCOME,
    )


def send_login_alert(
    user,
    *,
    request=None,
    method: str = "password",
    auth_session=None,
    idempotency_token: str = "",
) -> bool:
    if auth_session is not None:
        ip_address = str(auth_session.ip_address or "Unknown")
        user_agent = auth_session.user_agent or "Unknown"
        login_time = auth_session.created_at.isoformat()
        token = str(auth_session.pk)
    else:
        ip_address, user_agent = _request_context(request)
        login_time = timezone.now().isoformat()
        token = idempotency_token or str(uuid.uuid4())
    token_hash = hashlib.sha256(f"{user.pk}:{token}".encode()).hexdigest()[:32]
    body = (
        "A new login was completed for your Releviz account.\n\n"
        f"Account: {user.get_primary_contact_email()}\n"
        f"Time: {login_time}\n"
        f"Method: {method}\n"
        f"IP address: {ip_address}\n"
        f"User agent: {user_agent}\n\n"
        "If this was not you, change your password and contact support."
    )
    return _enqueue_account_email(
        user=user,
        idempotency_key=f"auth-login-alert:{token_hash}",
        message_id=f"<auth-login-alert-{token_hash}@releviz.local>",
        subject="New login to your Releviz account",
        body=body,
        html_body=render_branded_email(
            title="New login to your account",
            preheader="A new login was completed for your Releviz account.",
            eyebrow="Account security",
            paragraphs=("A new login was completed for your Releviz account.",),
            details=(
                ("Account", user.get_primary_contact_email()),
                ("Time", login_time),
                ("Method", method),
                ("IP address", ip_address),
                ("User agent", user_agent),
            ),
            cta_label="Review account settings",
            cta_url=frontend_url("/settings"),
            notice="If this was not you, change your password and contact support immediately.",
        ),
        message_type=EmailMessageLog.MessageType.LOGIN_ALERT,
        auth_session=auth_session,
    )


def verify_email_challenge(*, email: str, code: str, purpose: str, consume: bool = True):
    normalized = normalize_email(email)
    error_message = ""
    with transaction.atomic():
        challenge = (
            EmailAuthChallenge.objects.select_for_update()
            .select_related("member")
            .filter(
                target_email__iexact=normalized,
                purpose=purpose,
                status=EmailAuthChallenge.Status.PENDING,
            )
            .order_by("-created_at")
            .first()
        )
        if challenge is None:
            error_message = "Invalid or expired verification code."
        elif challenge.is_expired:
            challenge.status = EmailAuthChallenge.Status.EXPIRED
            challenge.save(update_fields=["status", "updated_at"])
            _cancel_auth_challenge_jobs(
                [challenge.pk],
                "Authentication challenge expired before use.",
            )
            error_message = "Invalid or expired verification code."
        elif challenge.attempts >= challenge.max_attempts:
            challenge.status = EmailAuthChallenge.Status.EXPIRED
            challenge.save(update_fields=["status", "updated_at"])
            _cancel_auth_challenge_jobs(
                [challenge.pk],
                "Authentication challenge exceeded its attempt limit.",
            )
            error_message = "Too many verification attempts."
        elif not check_password(str(code or ""), challenge.code_hash):
            challenge.attempts += 1
            challenge.save(update_fields=["attempts", "updated_at"])
            error_message = "Invalid or expired verification code."
        else:
            challenge.mark_verified()
            if consume:
                challenge.mark_consumed()
            _cancel_auth_challenge_jobs(
                [challenge.pk],
                "Authentication challenge was already used.",
            )
    if error_message:
        raise serializers.ValidationError({"code": error_message})
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
    send_registration_welcome(member)
    return member


def login_with_password(email: str, password: str, request=None, *, require_staff: bool = False):
    normalized = normalize_email(email)
    if request is not None and not password_login_allowed(normalized, request).allowed:
        get_user_model()().set_password(password)
        raise serializers.ValidationError({"detail": "Invalid email or password."})
    user = authenticate(request=request, username=normalized, password=password)
    if user is None or (require_staff and not user.is_staff):
        if request is not None:
            record_password_login_failure(normalized, request)
            logger.warning(
                "password_login_failed",
                extra={
                    "auth_identity": security_log_key(normalized),
                    "ip_address": client_ip(request),
                    "staff_required": require_staff,
                },
            )
        raise serializers.ValidationError({"detail": "Invalid email or password."})
    if request is not None:
        clear_password_login_failures(normalized, request)
        logger.info(
            "password_login_succeeded",
            extra={
                "member_id": str(user.pk),
                "ip_address": client_ip(request),
                "staff_required": require_staff,
            },
        )
    return user
