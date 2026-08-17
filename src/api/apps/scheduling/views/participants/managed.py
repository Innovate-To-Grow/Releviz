"""Create or reuse an organizer-managed participant."""

import uuid

from django.db import transaction
from rest_framework.exceptions import Throttled
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.security import AuthRateThrottle, consume_request_rate_limit
from apps.mail.models import EmailDeliveryRequest
from apps.scheduling.models import Event
from apps.scheduling.payloads import api_participant, email_delivery_request_payload
from apps.scheduling.services.invitations import (
    EventEmailRequestError,
    ManagedParticipantError,
    create_or_reuse_managed_participant_and_send,
)
from apps.scheduling.services.results import mark_event_results_dirty

from ..helpers import private_response


class ManagedParticipantView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [AuthRateThrottle]
    auth_rate_scope = "invitation_request"
    auth_rate_methods = {"POST"}

    def get_auth_rate_identity(self, request):
        return str(request.user.pk)

    @transaction.atomic
    def post(self, request):
        code = str(request.query_params.get("code") or "").strip()
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        try:
            idempotency_key = uuid.UUID(str(request.data.get("idempotencyKey") or ""))
        except (ValueError, TypeError, AttributeError):
            return Response({"error": "idempotencyKey must be a UUID"}, status=400)
        normalized_email = str(request.data.get("email") or "").strip().lower()
        if (
            normalized_email
            and not event.invitations.filter(email__iexact=normalized_email).exists()
            and not EmailDeliveryRequest.objects.filter(
                event=event,
                operation=EmailDeliveryRequest.Operation.INVITATION,
                idempotency_key=idempotency_key,
            ).exists()
        ):
            quota = consume_request_rate_limit(
                "invitation_recipient",
                request,
                str(request.user.pk),
                cost=1,
            )
            if not quota.allowed:
                raise Throttled(wait=quota.retry_after)
        try:
            result = create_or_reuse_managed_participant_and_send(
                event=event,
                organizer=request.user,
                name=request.data.get("name"),
                email=request.data.get("email"),
                idempotency_key=idempotency_key,
            )
        except (ManagedParticipantError, EventEmailRequestError) as exc:
            return Response({"error": str(exc)}, status=exc.status_code)
        participant = result["participant"]
        if result["participantCreated"] or result["participantRestored"]:
            mark_event_results_dirty(event)
        delivery_result = result["deliveryResult"]
        delivery_request = (
            email_delivery_request_payload(
                delivery_result["request"],
                jobs=delivery_result["jobs"],
            )
            if delivery_result
            else None
        )
        return private_response(
            {
                "participant": api_participant(
                    participant,
                    organizer_private=True,
                    invitation=result["invitation"],
                ),
                "created": result["participantCreated"],
                "restored": result["participantRestored"],
                "memberCreated": result["memberCreated"],
                "idempotent": delivery_result["idempotent"] if delivery_result else False,
                "deliveryRequest": delivery_request,
                "autoInvitedCount": delivery_request["recipientCount"] if delivery_request else 0,
            },
            status=201 if result["participantCreated"] else 200,
        )
