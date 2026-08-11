"""
Profile serializer for user information.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework import serializers

Member = get_user_model()


class ProfileSerializer(serializers.Serializer):
    """
    Serializer for user profile information.
    """

    member_uuid = serializers.UUIDField(read_only=True)
    email = serializers.EmailField(read_only=True)
    first_name = serializers.CharField(
        required=False,
        allow_blank=False,
        max_length=150,
        help_text="User's first name.",
    )
    middle_name = serializers.CharField(
        required=False,
        allow_blank=True,
        max_length=255,
        help_text="User's middle name.",
    )
    last_name = serializers.CharField(
        required=False,
        allow_blank=False,
        max_length=150,
        help_text="User's last name.",
    )
    organization = serializers.CharField(
        required=False,
        allow_blank=True,
        max_length=255,
        help_text="Organization or company the user belongs to.",
    )
    title = serializers.CharField(
        required=False,
        allow_blank=True,
        max_length=255,
        help_text="Job title or position.",
    )
    email_subscribe = serializers.BooleanField(
        required=False,
        help_text="Whether the member is subscribed to email communications.",
    )
    is_active = serializers.BooleanField(read_only=True)
    date_joined = serializers.DateTimeField(read_only=True)

    # noinspection PyMethodMayBeStatic
    def to_representation(self, instance: Member) -> dict:
        """
        Get profile data from the user instance.
        """
        profile_image = None
        if instance.profile_image:
            try:
                profile_image = (
                    instance.profile_image
                    if instance.profile_image.startswith("data:")
                    else f"data:image/png;base64,{instance.profile_image}"
                )
            except (AttributeError, TypeError):
                profile_image = None
        primary_contact = instance.get_primary_contact_email()
        return {
            "member_uuid": str(instance.member_uuid),
            "email": primary_contact.email_address if primary_contact else "",
            "email_verified": primary_contact.verified if primary_contact else False,
            "primary_email_id": str(primary_contact.pk) if primary_contact else None,
            "first_name": instance.first_name or "",
            "middle_name": instance.middle_name or "",
            "last_name": instance.last_name or "",
            "organization": instance.organization or "",
            "title": instance.title or "",
            "email_subscribe": primary_contact.subscribe if primary_contact else False,
            "is_active": instance.is_active,
            "date_joined": instance.date_joined.isoformat(),
            "profile_image": profile_image,
        }

    # noinspection PyMethodMayBeStatic
    def update(self, instance: Member, validated_data: dict) -> Member:
        """
        Update the user's profile with the validated data.
        """
        # Handle email_subscribe separately — backed by ContactEmail.subscribe
        email_sub = validated_data.pop("email_subscribe", None)
        if email_sub is not None:
            primary = instance.get_primary_contact_email()
            if primary:
                primary.subscribe = email_sub
                primary.save(update_fields=["subscribe"])

        # Update Member model fields
        member_fields_to_update = []
        for field in ("first_name", "middle_name", "last_name", "organization", "title"):
            if field in validated_data:
                setattr(instance, field, validated_data[field])
                member_fields_to_update.append(field)

        if member_fields_to_update:
            instance.save(update_fields=member_fields_to_update)

        return instance
