"""
Views for contact email management (CRUD + verification).
"""

from django.contrib.auth import get_user_model
from django.db import transaction
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.constants import (
    CONTACT_EMAIL_ADD_FAILED,
    CONTACT_EMAIL_PRIMARY_FAILED,
    CONTACT_EMAIL_SEND_FAILED,
    LAST_RECOVERY_CONTACT_DELETE_FAILED,
    VERIFICATION_INVALID,
)
from apps.authn.models import ContactEmail
from apps.authn.security.throttles import (
    ContactEmailCreateThrottle,
    EmailCodeUserRequestThrottle,
    EmailCodeVerifyThrottle,
)
from apps.authn.serializers import (
    ContactEmailCreateSerializer,
    ContactEmailSerializer,
    ContactEmailUpdateSerializer,
    ContactEmailVerifyCodeSerializer,
)
from apps.authn.services import (
    AuthChallengeInvalid,
    LastRecoveryContactError,
    create_contact_email,
    delete_contact_email,
    make_contact_email_primary,
    resend_contact_email_verification,
    verify_contact_email_code,
)

from ..helpers import challenge_error_response

Member = get_user_model()


def _get_contact_email(request, pk):
    return ContactEmail.objects.filter(pk=pk, member=request.user).first()


@transaction.atomic
def _update_contact_email(member, pk, validated_data):
    """Serialize type changes with primary swaps/deletes on the member mutex."""
    Member.objects.select_for_update().get(pk=member.pk)
    contact_email = ContactEmail.objects.select_for_update().filter(pk=pk, member=member).first()
    if contact_email is None:
        return None, "not_found"

    requested_type = validated_data.get("email_type")
    if contact_email.email_type == "primary" and requested_type and requested_type != "primary":
        return contact_email, "primary_demotion"
    if requested_type == "secondary":
        has_secondary = (
            ContactEmail.objects.select_for_update()
            .filter(member=member, email_type="secondary")
            .exclude(pk=pk)
            .exists()
        )
        if has_secondary:
            return contact_email, "secondary_exists"

    update_fields = []
    for field in ("email_type", "subscribe"):
        if field in validated_data:
            setattr(contact_email, field, validated_data[field])
            update_fields.append(field)
    if update_fields:
        contact_email.save(update_fields=update_fields + ["updated_at"])
    return contact_email, ""


class ContactEmailListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get_throttles(self):
        if self.request.method == "POST":
            return [ContactEmailCreateThrottle()]
        return []

    # noinspection PyMethodMayBeStatic
    def get(self, request):
        emails = ContactEmail.objects.filter(member=request.user).exclude(email_type="primary")
        serializer = ContactEmailSerializer(emails, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = ContactEmailCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        try:
            contact_email = create_contact_email(
                member=request.user,
                email_address=serializer.validated_data["email_address"],
                email_type=serializer.validated_data["email_type"],
                subscribe=serializer.validated_data["subscribe"],
            )
        except AuthChallengeInvalid:
            return Response(
                {"detail": CONTACT_EMAIL_ADD_FAILED}, status=status.HTTP_400_BAD_REQUEST
            )
        except Exception as exc:  # noqa: BLE001
            return challenge_error_response(exc)

        return Response(ContactEmailSerializer(contact_email).data, status=status.HTTP_201_CREATED)


class ContactEmailDetailView(APIView):
    permission_classes = [IsAuthenticated]

    # noinspection PyMethodMayBeStatic
    def patch(self, request, pk):
        serializer = ContactEmailUpdateSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        contact_email, error = _update_contact_email(
            request.user,
            pk,
            serializer.validated_data,
        )
        if error == "not_found":
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        if error == "primary_demotion":
            return Response(
                {
                    "email_type": [
                        "The primary email cannot be demoted directly. Make another verified email primary first."
                    ]
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        if error == "secondary_exists":
            return Response(
                {"email_type": ["You already have a secondary email."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(ContactEmailSerializer(contact_email).data, status=status.HTTP_200_OK)

    # noinspection PyMethodMayBeStatic
    def delete(self, request, pk):
        contact_email = _get_contact_email(request, pk)
        if contact_email is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        try:
            delete_contact_email(member=request.user, contact_email_id=pk)
        except LastRecoveryContactError:
            return Response(
                {"detail": LAST_RECOVERY_CONTACT_DELETE_FAILED}, status=status.HTTP_409_CONFLICT
            )
        except AuthChallengeInvalid:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        return Response(status=status.HTTP_204_NO_CONTENT)


class ContactEmailRequestVerificationView(APIView):
    permission_classes = [IsAuthenticated]
    # Per-user cap: the anon EmailCodeRequestThrottle never fires for an
    # authenticated caller, leaving SES sends to an attacker-supplied address
    # unbounded.
    throttle_classes = [EmailCodeUserRequestThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request, pk):
        contact_email = _get_contact_email(request, pk)
        if contact_email is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        if contact_email.verified:
            return Response(
                {"detail": "This email is already verified."}, status=status.HTTP_400_BAD_REQUEST
            )

        try:
            result = resend_contact_email_verification(member=request.user, contact_email_id=pk)
        except AuthChallengeInvalid:
            return Response(
                {"detail": CONTACT_EMAIL_SEND_FAILED}, status=status.HTTP_400_BAD_REQUEST
            )
        except Exception as exc:  # noqa: BLE001
            return challenge_error_response(exc)

        return Response(result, status=status.HTTP_202_ACCEPTED)


class ContactEmailVerifyCodeView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [EmailCodeVerifyThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request, pk):
        contact_email = _get_contact_email(request, pk)
        if contact_email is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        serializer = ContactEmailVerifyCodeSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        try:
            updated = verify_contact_email_code(
                member=request.user,
                contact_email_id=pk,
                code=serializer.validated_data["code"],
            )
        except AuthChallengeInvalid:
            return Response({"detail": VERIFICATION_INVALID}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:  # noqa: BLE001
            return challenge_error_response(exc)

        return Response(ContactEmailSerializer(updated).data, status=status.HTTP_200_OK)


class ContactEmailMakePrimaryView(APIView):
    permission_classes = [IsAuthenticated]

    # noinspection PyMethodMayBeStatic
    def post(self, request, pk):
        contact_email = _get_contact_email(request, pk)
        if contact_email is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        try:
            updated = make_contact_email_primary(member=request.user, contact_email_id=pk)
        except AuthChallengeInvalid:
            return Response(
                {"detail": CONTACT_EMAIL_PRIMARY_FAILED}, status=status.HTTP_400_BAD_REQUEST
            )
        except Exception as exc:  # noqa: BLE001
            return challenge_error_response(exc)

        return Response(ContactEmailSerializer(updated).data, status=status.HTTP_200_OK)
