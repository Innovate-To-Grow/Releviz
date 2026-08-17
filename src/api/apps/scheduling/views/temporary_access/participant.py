"""Save availability from a temporary event session."""

import logging

from django.db import transaction
from django.utils import timezone
from rest_framework.permissions import AllowAny
from rest_framework.views import APIView

from apps.authn.security import enforce_cookie_request_origin
from apps.scheduling.models import Event, Participant, ScheduleEditRecord
from apps.scheduling.payloads import api_participant
from apps.scheduling.permissions import weight_for_participant
from apps.scheduling.services.availability import validate_availability
from apps.scheduling.services.events import response_write_error
from apps.scheduling.services.invitations import (
    mark_invitation_for_member,
    mark_invitation_response_withdrawn,
)
from apps.scheduling.services.results import (
    participant_is_excluded,
    request_event_results_recompute,
)
from apps.scheduling.services.temporary_access import (
    clear_temporary_session_cookie,
    temporary_session_from_request,
)

from ..helpers import current_member_access_level, record_schedule_edit, temp_private_response
from .helpers import inactive_session_response

security_logger = logging.getLogger("releviz.security")


class TemporaryAccessParticipantView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    @transaction.atomic
    def put(self, request):
        enforce_cookie_request_origin(request)
        event_code = str(request.query_params.get("code") or "").strip()
        if not event_code:
            return temp_private_response({"error": "code is required"}, status=400)
        session = temporary_session_from_request(request, event_code=event_code)
        if session is None:
            return inactive_session_response(
                request,
                event_code=event_code,
                operation="update_participant",
            )

        participant = Participant.objects.select_for_update(of=("self",)).get(
            pk=session.participant_id
        )
        event = Event.objects.get(pk=participant.event_id)
        participant.event = event
        if current_member_access_level(participant.member_id) != "temporary":
            session.revoke()
            response = temp_private_response(
                {
                    "error": "This account now has full access. Sign in to continue.",
                    "errorCode": "temp_account_upgraded",
                },
                status=403,
            )
            clear_temporary_session_cookie(response)
            return response
        if "email" in request.data or "contactEmail" in request.data:
            return temp_private_response(
                {
                    "error": "Participant email cannot be changed.",
                    "errorCode": "participant_email_immutable",
                },
                status=400,
            )
        write_error = response_write_error(event)
        if write_error:
            return temp_private_response(
                {
                    "error": write_error,
                    "errorCode": "event_responses_locked",
                },
                status=409,
            )
        weight = weight_for_participant(event, participant)
        if participant_is_excluded(participant, weight):
            return temp_private_response(
                {
                    "error": "Excluded participants cannot change availability",
                    "errorCode": "participant_excluded",
                },
                status=403,
            )

        updates = {}
        for field, label, target in (
            (
                "availabilityInperson",
                "availabilityInperson",
                "availability_inperson",
            ),
            (
                "availabilityVirtual",
                "availabilityVirtual",
                "availability_virtual",
            ),
        ):
            if field in request.data:
                error = validate_availability(request.data[field], event, label)
                if error:
                    return temp_private_response({"error": error}, status=400)
                updates[target] = request.data[field]
        if "submitted" in request.data:
            submitted = request.data["submitted"]
            if submitted not in {0, 1}:
                return temp_private_response(
                    {"error": "submitted must be a boolean"},
                    status=400,
                )
            updates["submitted"] = bool(submitted)
        if not updates:
            return temp_private_response({"participant": api_participant(participant)})

        expected_version = request.data.get("expectedVersion")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int):
            return temp_private_response(
                {
                    "error": "expectedVersion is required",
                    "errorCode": "participant_version_required",
                },
                status=428,
            )
        values_match = all(getattr(participant, key) == value for key, value in updates.items())
        if participant.version != expected_version and not values_match:
            return temp_private_response(
                {
                    "error": (
                        "Your availability changed in another session. Reload before saving again."
                    ),
                    "errorCode": "participant_version_conflict",
                    "participant": api_participant(participant),
                },
                status=409,
            )
        if values_match:
            return temp_private_response({"participant": api_participant(participant)})

        was_submitted = participant.submitted
        for key, value in updates.items():
            setattr(participant, key, value)
        timestamp_fields = []
        now = timezone.now()
        if participant.submitted:
            if participant.first_submitted_at is None:
                participant.first_submitted_at = now
                timestamp_fields.append("first_submitted_at")
            participant.last_submitted_at = now
            timestamp_fields.append("last_submitted_at")
        elif participant.first_draft_saved_at is None:
            participant.first_draft_saved_at = now
            timestamp_fields.append("first_draft_saved_at")
        participant.version += 1
        participant.save(
            update_fields=[*updates.keys(), *timestamp_fields, "version", "updated_at"]
        )
        if participant.submitted:
            mark_invitation_for_member(
                event=event,
                member=participant.member,
                submitted=True,
            )
        elif was_submitted:
            mark_invitation_response_withdrawn(event=event, member=participant.member)
        else:
            mark_invitation_for_member(
                event=event,
                member=participant.member,
                draft_saved=True,
            )
        record_schedule_edit(
            event=event,
            participant=participant,
            actor=session.member,
            source=ScheduleEditRecord.Source.SELF,
            was_submitted=was_submitted,
        )
        request_event_results_recompute(event)
        security_logger.info(
            "temporary_participant_response_updated",
            extra={
                "event_id": str(event.pk),
                "member_id": str(participant.member_id),
                "participant_version": participant.version,
                "submitted": participant.submitted,
            },
        )
        return temp_private_response({"participant": api_participant(participant)})
