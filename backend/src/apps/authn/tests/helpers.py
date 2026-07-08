from django.contrib.auth import get_user_model
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.models import ContactEmail


def create_member(
    email: str,
    first_name: str = "Test",
    last_name: str = "User",
    password: str = "password123",
    **extra_fields,
):
    Member = get_user_model()
    contact_verified = extra_fields.pop("contact_verified", True)
    member = Member.objects.create_user(
        password=password,
        first_name=first_name,
        last_name=last_name,
        email=email,
        is_active=extra_fields.pop("is_active", True),
        **extra_fields,
    )
    ContactEmail.objects.create(
        member=member,
        email_address=email,
        email_type="primary",
        verified=contact_verified,
    )
    return member


def token_for(member) -> str:
    return str(RefreshToken.for_user(member).access_token)
