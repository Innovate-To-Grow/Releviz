"""Account-related serializers for email-code flows."""

from rest_framework import serializers

from apps.authn.services import get_member_auth_emails


class AccountEmailsSerializer(serializers.Serializer):
    emails = serializers.ListField(child=serializers.EmailField(), read_only=True)

    def to_representation(self, instance):
        return {"emails": get_member_auth_emails(instance)}
