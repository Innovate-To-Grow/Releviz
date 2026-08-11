"""Shared helpers for public email-code views."""

from rest_framework import serializers, status
from rest_framework.response import Response

from apps.authn.constants import VERIFICATION_INVALID
from apps.authn.services import AuthChallengeInvalid

from ..helpers import challenge_error_response


def request_code_response(request, serializer_class):
    serializer = serializer_class(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    try:
        payload = serializer.save()
    except serializers.ValidationError as exc:
        return Response(exc.detail, status=status.HTTP_400_BAD_REQUEST)
    except Exception as exc:  # noqa: BLE001
        return challenge_error_response(exc)
    return Response(payload, status=status.HTTP_202_ACCEPTED)


def auth_challenge_response(request, serializer_class):
    serializer = serializer_class(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    try:
        payload = serializer.save()
    except AuthChallengeInvalid:
        return Response({"detail": VERIFICATION_INVALID}, status=status.HTTP_400_BAD_REQUEST)
    return Response(payload, status=status.HTTP_200_OK)
