"""Shared factories for core tests using the current Member identity model."""

from apps.authn.models import ContactEmail, Member


def make_member(
    *,
    email="member@example.com",
    password="testpass123",
    first_name="Test",
    last_name="Member",
    **kwargs,
):
    member = Member.objects.create_user(
        password=password,
        first_name=first_name,
        last_name=last_name,
        **kwargs,
    )
    ContactEmail.objects.create(
        member=member,
        email_address=email,
        email_type="primary",
        verified=True,
    )
    return member


def make_admin(*, apps=None, **kwargs):
    return make_member(is_staff=True, admin_apps=list(apps or []), **kwargs)


def make_superuser(
    *,
    email="admin@example.com",
    password="testpass123",
    first_name="Admin",
    last_name="User",
    **kwargs,
):
    member = Member.objects.create_superuser(
        password=password,
        first_name=first_name,
        last_name=last_name,
        **kwargs,
    )
    ContactEmail.objects.create(
        member=member,
        email_address=email,
        email_type="primary",
        verified=True,
    )
    return member
