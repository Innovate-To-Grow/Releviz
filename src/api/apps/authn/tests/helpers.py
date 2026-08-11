"""
Test helpers for creating members with ContactEmail records.
"""

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
