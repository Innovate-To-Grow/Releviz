"""
Service layer for passwordless phone authentication (signup + login).

A caller proves ownership of a phone number via the SMS OTP in
``services/sms/sns_verify.py`` (PostgreSQL-backed, purpose/context-bound, and
one-time). Once the code is approved,
:func:`resolve_or_create_member_by_phone` either logs in the member that owns
the number or creates a brand-new phone-only account.

This mirrors the unified passwordless *email* flow. The OTP service invokes this
member-resolution step as its approved callback, so OTP consumption, account
creation/resolution, and JWT creation commit or roll back together. The member
is created **active in one shot** (there is no "pending phone member" state).
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import transaction

from apps.authn.models import ContactPhone
from apps.authn.services.contacts.contact_phones import (
    create_contact_phone,
    national_to_e164,
    normalize_to_national,
)
from apps.authn.services.email.challenges import AuthChallengeInvalid


class PhoneAccountInactive(Exception):
    """Raised when a phone login resolves to a deactivated member.

    ``is_active=False`` is the project's only account-disable mechanism (admin
    ``deactivate_members``, unsubscribe filters, staff-login gating). Proving
    phone ownership must NOT silently revive a disabled account, so the login
    path rejects it instead of reactivating — mirroring the email-code flow,
    which returns a generic invalid-code 400 for ``flow == "login"`` when the
    member is inactive. The view maps this to that same generic 400.
    """


def request_phone_auth(phone_number: str, region: str = "1-US") -> dict:
    """Send an SMS verification code for passwordless phone auth.

    Returns a generic message that never reveals whether the number maps to an
    existing account (prevents account enumeration). May raise
    ``PhoneVerificationThrottled`` / ``PhoneVerificationDeliveryError``.
    """
    from apps.authn.services.sms import start_phone_verification

    national = normalize_to_national(phone_number, region)
    e164 = national_to_e164(national, region)
    challenge = start_phone_verification(
        e164,
        purpose="phone_auth",
        context_identifier=region,
    )
    payload = {"message": "If this number can receive SMS, a verification code has been sent."}
    if isinstance(challenge, dict) and challenge.get("challenge_id"):
        payload["challenge_id"] = challenge["challenge_id"]
    return payload


def _create_blank_active_member():
    """Create an active, name-less member with no usable password.

    Empty name fields make ``member.requires_profile_completion`` True, so the
    auth response routes the user to the complete-profile step.
    """
    member_model = get_user_model()
    member = member_model(is_active=True, first_name="", last_name="", organization="")
    member.set_unusable_password()
    member.save()
    return member


def _login_existing(contact: ContactPhone):
    """Return the member owning ``contact``, marking the phone verified if needed
    (phone ownership was just proven this request).

    Raises :class:`PhoneAccountInactive` when the member is deactivated — a
    disabled account must not be revived by a phone login. The guard runs before
    any mutation so a rejected attempt leaves the member and contact untouched.
    Only ever reached on the login path (register/orphan-claim create a fresh
    active member), so there is no legitimate reactivation case here.
    """
    member = contact.member
    if not member.is_active:
        raise PhoneAccountInactive
    if not contact.verified:
        contact.verified = True
        contact.save(update_fields=["verified", "updated_at"])
    return member


def resolve_or_create_member_by_phone(phone_number: str, region: str = "1-US"):
    """Resolve (or create) the member that owns ``phone_number``.

    MUST be called only after ``check_phone_verification`` has approved — the
    caller has proven phone ownership. Returns ``(member, flow)`` where ``flow``
    is ``"login"`` (existing account) or ``"register"`` (new account).
    """
    national = normalize_to_national(phone_number, region)
    with transaction.atomic():
        existing = (
            ContactPhone.objects.select_for_update(of=("self",))
            .select_related("member")
            .filter(phone_number=national)
            .first()
        )
        if existing is not None and existing.member is not None:
            return _login_existing(existing), "login"

        if existing is not None and existing.member is None:
            # Orphaned member-less phone (e.g. legacy import) — claim it.
            member = _create_blank_active_member()
            existing.member = member
            existing.verified = True
            existing.save(update_fields=["member", "verified", "updated_at"])
            return member, "register"

        # No row yet → create a new account. A nested atomic gives a savepoint so
        # a unique-constraint race (concurrent signup on the same number) is
        # recoverable: the IntegrityError surfaced by create_contact_phone rolls
        # back only the savepoint, leaving the outer transaction usable.
        try:
            with transaction.atomic():
                member = _create_blank_active_member()
                contact = create_contact_phone(member=member, phone_number=national, region=region, subscribe=False)
                contact.verified = True
                contact.save(update_fields=["verified", "updated_at"])
            return member, "register"
        except AuthChallengeInvalid:
            existing = (
                ContactPhone.objects.select_for_update(of=("self",))
                .select_related("member")
                .filter(phone_number=national)
                .first()
            )
            if existing is not None and existing.member is not None:
                return _login_existing(existing), "login"
            raise
