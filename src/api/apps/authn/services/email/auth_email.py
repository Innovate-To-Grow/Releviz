"""
Helpers for resolving which email addresses are eligible for auth flows.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.authn.models import ContactEmail

Member = get_user_model()


@dataclass(frozen=True)
class ResolvedAuthEmail:
    member: Member
    delivery_email: str
    source_type: str


@dataclass(frozen=True)
class ResolvedLoginIdentifier:
    member: Member
    via: str  # "email" | "phone"
    email: str = ""  # normalized verified email (via == "email")
    e164: str = ""  # E.164 of the matched verified phone (via == "phone")


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def resolve_auth_email(email: str, *, require_active: bool = True) -> ResolvedAuthEmail | None:
    normalized = normalize_email(email)
    if not normalized:
        return None

    contact = (
        ContactEmail.objects.select_related("member").filter(email_address__iexact=normalized, verified=True).first()
    )
    if contact and contact.member and (contact.member.is_active or not require_active):
        return ResolvedAuthEmail(member=contact.member, delivery_email=normalized, source_type="contact")

    return None


def resolve_login_identifier(identifier: str, *, require_active: bool = False) -> ResolvedLoginIdentifier | None:
    """Resolve a login identifier (email or phone) to a member.

    Email-first: an ``@``-containing identifier resolves through a verified
    ``ContactEmail`` (preserving existing behavior). Otherwise the digits are
    normalized across the supported phone regions and matched against a
    *verified* ``ContactPhone``. Only verified contacts resolve — an unverified
    email or phone is never a valid login/recovery channel.
    """
    identifier = (identifier or "").strip()
    if not identifier:
        return None

    if "@" in identifier:
        resolved = resolve_auth_email(identifier, require_active=require_active)
        if resolved is None:
            return None
        return ResolvedLoginIdentifier(member=resolved.member, via="email", email=resolved.delivery_email)

    # Phone path: normalize to the stored national digits and match a verified phone.
    from apps.authn.models import ContactPhone
    from apps.authn.models.contact.phone_regions import PHONE_REGION_CHOICES
    from apps.authn.services.contacts.contact_phones import normalize_to_national

    if not re.search(r"\d", identifier):
        return None

    seen: set[str] = set()
    for region, _label in PHONE_REGION_CHOICES:
        national = normalize_to_national(identifier, region)
        if not national or national in seen:
            continue
        seen.add(national)
        contact = ContactPhone.objects.select_related("member").filter(phone_number=national, verified=True).first()
        if contact and contact.member and (contact.member.is_active or not require_active):
            return ResolvedLoginIdentifier(member=contact.member, via="phone", e164=contact.to_e164())

    return None


def get_member_auth_emails(member: Member) -> list[str]:
    emails: list[str] = []
    seen: set[str] = set()

    def add(email_value: str):
        normalized = normalize_email(email_value)
        if normalized and normalized not in seen:
            seen.add(normalized)
            emails.append(normalized)

    contacts = ContactEmail.objects.filter(member=member, verified=True).order_by("email_type", "created_at")
    for contact in contacts:
        add(contact.email_address)

    return emails


def get_unclaimed_contact_email(email: str) -> ContactEmail | None:
    normalized = normalize_email(email)
    if not normalized:
        return None
    return ContactEmail.objects.filter(email_address__iexact=normalized, member__isnull=True).first()


def claim_unclaimed_contact_email(
    email: str,
    *,
    member: Member,
    email_type: str = "primary",
    verified: bool = False,
) -> ContactEmail | None:
    normalized = normalize_email(email)
    if not normalized:
        return None
    updated = ContactEmail.objects.filter(email_address__iexact=normalized, member__isnull=True).update(
        member=member,
        email_type=email_type,
        verified=verified,
        updated_at=timezone.now(),
    )
    if not updated:
        return None
    return ContactEmail.objects.filter(email_address__iexact=normalized, member=member).first()


def get_pending_registration_member(email: str) -> Member | None:
    normalized = normalize_email(email)
    if not normalized:
        return None
    contact = (
        ContactEmail.objects.select_related("member")
        .filter(email_address__iexact=normalized, member__is_active=False)
        .first()
    )
    return contact.member if contact else None


def registration_email_conflicts(email: str, *, exclude_member_id=None, allow_unclaimed: bool = False) -> bool:
    normalized = normalize_email(email)
    qs = ContactEmail.objects.filter(email_address__iexact=normalized)
    if exclude_member_id:
        qs = qs.exclude(member_id=exclude_member_id)
    if allow_unclaimed:
        qs = qs.exclude(member__isnull=True)
    return qs.exists()
