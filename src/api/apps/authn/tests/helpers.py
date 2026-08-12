"""
Test helpers for creating members with ContactEmail records.
"""

from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.models import ContactEmail, Member


def create_test_member(email, password="testpass123", **kwargs):
    """
    Create a Member with a primary ContactEmail record.
    Member.email is left blank; the email is stored in ContactEmail.
    """
    member = Member.objects.create_user(
        password=password,
        **kwargs,
    )
    ContactEmail.objects.create(
        member=member,
        email_address=email,
        email_type="primary",
        verified=True,
    )
    # Store the email on the instance for convenience in tests
    member._test_email = email
    return member


def create_member(
    email,
    first_name="Test",
    last_name="Member",
    password="testpass123",
    *,
    contact_verified=True,
    **kwargs,
):
    """Backward-compatible scheduling test helper."""

    normalized_email = str(email).strip().lower()
    kwargs.setdefault("is_active", True)
    member = Member.objects.create_user(
        password=password,
        email=normalized_email,
        first_name=first_name,
        last_name=last_name,
        **kwargs,
    )
    ContactEmail.objects.create(
        member=member,
        email_address=normalized_email,
        email_type="primary",
        verified=contact_verified,
    )
    return member


def token_for(member) -> str:
    """Return an access token suitable for authenticated API tests."""

    return str(RefreshToken.for_user(member).access_token)
