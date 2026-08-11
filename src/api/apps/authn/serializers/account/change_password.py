"""
Change password serializer for authenticated users.
"""

from rest_framework import serializers

from ..helpers import decrypt_field, decrypt_password_pair


class ChangePasswordSerializer(serializers.Serializer):
    """
    Serializer for changing an authenticated user's password.
    Passwords should be RSA encrypted with the public key.
    """

    current_password = serializers.CharField(
        write_only=True,
        required=True,
        help_text="Current password (RSA encrypted).",
    )
    new_password = serializers.CharField(
        write_only=True,
        required=True,
        help_text="New password (RSA encrypted).",
    )
    new_password_confirm = serializers.CharField(
        write_only=True,
        required=True,
        help_text="New password confirmation (RSA encrypted).",
    )
    key_id = serializers.CharField(
        required=False,
        allow_blank=True,
        help_text="Key ID used for encryption (for key rotation handling).",
    )

    def validate(self, attrs: dict) -> dict:
        user = self.context["request"].user
        key_id = attrs.get("key_id", "")

        try:
            current_password = decrypt_field(attrs["current_password"], key_id)
        except serializers.ValidationError as exc:
            raise serializers.ValidationError({"current_password": exc.detail}) from exc

        if not user.check_password(current_password):
            raise serializers.ValidationError({"current_password": "Current password is incorrect."})

        attrs["_decrypted_new_password"] = decrypt_password_pair(attrs, user=user)
        return attrs
