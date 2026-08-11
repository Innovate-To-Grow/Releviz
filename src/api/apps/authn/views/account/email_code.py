"""
Views for authenticated email-code account flows.
"""
# noinspection DuplicatedCode

from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.constants import VERIFICATION_LINK_INVALID
from apps.authn.security.throttles import (
    EmailCodeUserRequestThrottle,
    EmailCodeVerifyThrottle,
)
from apps.authn.serializers import (
    AccountEmailsSerializer,
    ChangePasswordCodeConfirmSerializer,
    ChangePasswordCodeRequestSerializer,
    ChangePasswordCodeVerifySerializer,
    DeleteAccountCodeConfirmSerializer,
    DeleteAccountCodeRequestSerializer,
    DeleteAccountCodeVerifySerializer,
)
from apps.authn.services import AuthChallengeInvalid

from ..helpers import challenge_error_response


class AccountEmailsView(APIView):
    permission_classes = [IsAuthenticated]

    # noinspection PyMethodMayBeStatic
    def get(self, request):
        serializer = AccountEmailsSerializer(instance=request.user)
        return Response(serializer.data, status=status.HTTP_200_OK)


class ChangePasswordCodeRequestView(APIView):
    permission_classes = [IsAuthenticated]
    # Per-user cap on the email send budget.
    throttle_classes = [EmailCodeUserRequestThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = ChangePasswordCodeRequestSerializer(data=request.data, context={"request": request})
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        try:
            payload = serializer.save()
        except serializers.ValidationError as exc:
            return Response(exc.detail, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:  # noqa: BLE001
            return challenge_error_response(exc)
        return Response(payload, status=status.HTTP_202_ACCEPTED)


class ChangePasswordCodeVerifyView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [EmailCodeVerifyThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = ChangePasswordCodeVerifySerializer(data=request.data, context={"request": request})
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        payload = serializer.save()
        return Response(payload, status=status.HTTP_200_OK)


class ChangePasswordCodeConfirmView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [EmailCodeVerifyThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = ChangePasswordCodeConfirmSerializer(data=request.data, context={"request": request})
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        try:
            payload = serializer.save()
        except AuthChallengeInvalid:
            return Response({"detail": VERIFICATION_LINK_INVALID}, status=status.HTTP_400_BAD_REQUEST)
        return Response(payload, status=status.HTTP_200_OK)


class DeleteAccountCodeRequestView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [EmailCodeUserRequestThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = DeleteAccountCodeRequestSerializer(data=request.data, context={"request": request})
        # Defensive guard: this serializer has no fields, so is_valid() is always True.
        if not serializer.is_valid():  # pragma: no cover
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        try:
            payload = serializer.save()
        except serializers.ValidationError as exc:
            return Response(exc.detail, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:  # noqa: BLE001
            return challenge_error_response(exc)
        return Response(payload, status=status.HTTP_202_ACCEPTED)


class DeleteAccountCodeVerifyView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [EmailCodeVerifyThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = DeleteAccountCodeVerifySerializer(data=request.data, context={"request": request})
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        payload = serializer.save()
        return Response(payload, status=status.HTTP_200_OK)


class DeleteAccountCodeConfirmView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [EmailCodeVerifyThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = DeleteAccountCodeConfirmSerializer(data=request.data, context={"request": request})
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        try:
            payload = serializer.save()
        except AuthChallengeInvalid:
            return Response({"detail": VERIFICATION_LINK_INVALID}, status=status.HTTP_400_BAD_REQUEST)
        return Response(payload, status=status.HTTP_200_OK)
