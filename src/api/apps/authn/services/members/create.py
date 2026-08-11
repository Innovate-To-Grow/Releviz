from typing import Any

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction

from apps.authn.models import ContactEmail, Member


class CreateMemberService:
    """Service for creating new member accounts."""

    @staticmethod
    @transaction.atomic
    def create_member(
        password: str,
        first_name: str,
        last_name: str,
        email: str = "",
        middle_name: str = "",
        organization: str = "",
        is_active: bool = True,
        is_staff: bool = False,
    ) -> dict[str, Any]:
        """
        Create a new member account.

        Args:
            password: Plain text password (will be hashed)
            first_name: Member's first name (required)
            last_name: Member's last name (required)
            email: Email address (optional, unique if provided)
            middle_name: Member's middle name (optional)
            organization: Organization or company name (optional)
            is_active: Whether the account is active (default: True)
            is_staff: Whether user has admin permissions (default: False)

        Returns:
            dict: {
                "success": bool,
                "member": Member instance or None,
                "member_uuid": UUID str or None,
                "error": str or None
            }

        Raises:
            ValueError: If required fields are missing or invalid
        """
        if not password or not password.strip():
            return {
                "success": False,
                "member": None,
                "member_uuid": None,
                "error": "Password is required",
            }

        if not first_name or not first_name.strip():
            return {
                "success": False,
                "member": None,
                "member_uuid": None,
                "error": "First name is required",
            }

        if not last_name or not last_name.strip():
            return {
                "success": False,
                "member": None,
                "member_uuid": None,
                "error": "Last name is required",
            }

        try:
            # Check if email already exists (if provided)
            if email and ContactEmail.objects.filter(email_address__iexact=email.strip()).exists():
                return {
                    "success": False,
                    "member": None,
                    "member_uuid": None,
                    "error": f"Email '{email}' already exists",
                }

            # Create the member using create_user which handles password hashing
            member = Member.objects.create_user(
                password=password,
                first_name=first_name.strip(),
                middle_name=middle_name.strip() if middle_name else "",
                last_name=last_name.strip(),
                organization=organization.strip() if organization else "",
                is_active=is_active,
                is_staff=is_staff,
            )

            # Create primary ContactEmail if email was provided
            if email and email.strip():
                ContactEmail.objects.create(
                    member=member,
                    email_address=email.strip(),
                    email_type="primary",
                    verified=True,
                )

            return {
                "success": True,
                "member": member,
                "member_uuid": str(member.member_uuid),
                "error": None,
            }

        except IntegrityError as e:
            return {
                "success": False,
                "member": None,
                "member_uuid": None,
                "error": f"Database integrity error: {str(e)}",
            }

        except ValidationError as e:
            return {
                "success": False,
                "member": None,
                "member_uuid": None,
                "error": f"Validation error: {str(e)}",
            }

        except Exception as e:
            return {
                "success": False,
                "member": None,
                "member_uuid": None,
                "error": f"Unexpected error: {str(e)}",
            }
