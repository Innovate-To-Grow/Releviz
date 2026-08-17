"""Update or hide a single participant's response and roster metadata."""

import logging

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

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

from ..helpers import (
    organizer_participant_payload,
    organizer_response_write_error,
    private_response,
    record_schedule_edit,
)

security_logger = logging.getLogger("releviz.security")


class ParticipantUpdateView(APIView):
    permission_classes = [IsAuthenticated]

    def _get_event_participant(self, request):
        code = request.query_params.get("code", "")
        participant_id = request.query_params.get("participantId", "")
        if not code or not participant_id:
            return (
                None,
                None,
                Response({"error": "code and participantId are required"}, status=400),
            )
        event = Event.objects.filter(code=code).first()
        if event is None:
            return None, None, Response({"error": "Event not found"}, status=404)
        participant = event.participants.filter(member_id=participant_id).first()
        if participant is None:
            return event, None, Response({"error": "Participant not found"}, status=404)
        # Serialize with account upgrades and schedule reconfiguration through
        # the participation row, while avoiding the shared Event row hot spot.
        participant = Participant.objects.select_for_update(of=("self",)).get(pk=participant.pk)
        event = Event.objects.get(pk=participant.event_id)
        member = get_user_model().objects.get(pk=participant.member_id)
        participant.event = event
        participant.member = member
        return event, participant, None

    @transaction.atomic
    def put(self, request):
        event, participant, error = self._get_event_participant(request)
        if error:
            return error

        is_organizer = event.organizer_id == request.user.pk
        is_self = participant.member_id == request.user.pk
        is_temporary = participant.member.access_level == "temporary"
        organizer_can_edit_response = is_organizer and is_temporary
        response_fields = {"availabilityInperson", "availabilityVirtual", "submitted"}
        is_response_mutation = any(field in request.data for field in response_fields)
        is_name_mutation = "name" in request.data
        is_roster_metadata_mutation = any(
            field in request.data for field in ("groupName", "sortOrder")
        )
        is_versioned_mutation = is_response_mutation or is_name_mutation

        if is_organizer and not is_temporary and is_versioned_mutation:
            security_logger.warning(
                "organizer_participant_edit_denied",
                extra={
                    "event_id": str(event.pk),
                    "organizer_id": str(request.user.pk),
                    "member_id": str(participant.member_id),
                    "account_access": "full",
                },
            )

        def response_participant_payload():
            if is_organizer:
                return organizer_participant_payload(participant, event)
            return api_participant(participant)

        if is_response_mutation and not (is_self or organizer_can_edit_response):
            payload = {
                "error": "Only participants can change their own availability",
                "errorCode": "participant_update_forbidden",
            }
            if is_organizer:
                payload = {
                    "error": (
                        "This participant has full access; the organizer can no longer "
                        "change their availability."
                    ),
                    "errorCode": "organizer_edit_full_account",
                    "participant": response_participant_payload(),
                }
            if is_organizer:
                return private_response(payload, status=403)
            return Response(payload, status=403)
        if is_name_mutation and not organizer_can_edit_response:
            payload = {
                "error": "Only the organizer can rename a temporary participant",
                "errorCode": "participant_update_forbidden",
            }
            if is_organizer:
                payload["errorCode"] = "organizer_edit_full_account"
                payload["participant"] = response_participant_payload()
                return private_response(payload, status=403)
            return Response(payload, status=403)
        if not is_organizer and not is_self:
            return Response(
                {
                    "error": "You do not have permission to update this participant",
                    "errorCode": "participant_update_forbidden",
                },
                status=403,
            )
        if is_organizer and is_roster_metadata_mutation:
            write_error = organizer_response_write_error(event)
            if write_error:
                return Response(
                    {
                        "error": write_error,
                        "errorCode": "participant_roster_locked",
                    },
                    status=409,
                )
        if "email" in request.data or "contactEmail" in request.data:
            return Response(
                {
                    "error": "Participant email cannot be changed.",
                    "errorCode": "participant_email_immutable",
                },
                status=400,
            )
        if is_versioned_mutation:
            write_error = (
                organizer_response_write_error(event)
                if organizer_can_edit_response
                else response_write_error(event)
            )
            if write_error:
                return Response(
                    {
                        "error": write_error,
                        "errorCode": "participant_response_locked",
                    },
                    status=409,
                )
        if is_response_mutation:
            weight = weight_for_participant(event, participant)
            if participant_is_excluded(participant, weight):
                return Response(
                    {
                        "error": "Excluded participants cannot change availability",
                        "errorCode": "participant_excluded",
                    },
                    status=403,
                )

        updates = {}
        for field, label in (
            ("availabilityInperson", "availabilityInperson"),
            ("availabilityVirtual", "availabilityVirtual"),
        ):
            if field in request.data:
                err = validate_availability(request.data[field], event, label)
                if err:
                    return Response({"error": err}, status=400)
                target = (
                    "availability_inperson"
                    if field == "availabilityInperson"
                    else "availability_virtual"
                )
                updates[target] = request.data[field]

        if is_name_mutation:
            name = str(request.data.get("name") or "").strip()
            if not name:
                return Response({"error": "Name is required"}, status=400)
            if len(name) > 100:
                return Response({"error": "Name too long (max 100)"}, status=400)
            updates["participant_name"] = name

        if "submitted" in request.data:
            submitted = request.data["submitted"]
            if submitted not in {0, 1}:
                return Response({"error": "submitted must be a boolean"}, status=400)
            updates["submitted"] = bool(submitted)

        if "groupName" in request.data:
            if not is_organizer:
                return Response(
                    {
                        "error": "Only the organizer can update participant groups",
                        "errorCode": "participant_update_forbidden",
                    },
                    status=403,
                )
            updates["group_name"] = request.data.get("groupName") or None

        if "sortOrder" in request.data:
            if not is_organizer:
                return Response(
                    {
                        "error": "Only the organizer can reorder participants",
                        "errorCode": "participant_update_forbidden",
                    },
                    status=403,
                )
            try:
                updates["sort_order"] = (
                    int(request.data["sortOrder"])
                    if request.data["sortOrder"] is not None
                    else None
                )
            except (TypeError, ValueError):
                return Response({"error": "sortOrder must be an integer or null"}, status=400)

        if not updates:
            return private_response({"participant": response_participant_payload()})

        def values_match():
            for key, value in updates.items():
                current = getattr(participant, key)
                if current != value:
                    return False
            return True

        def track_unchanged_response():
            if not is_response_mutation:
                return
            if participant.submitted and updates.get("submitted"):
                mark_invitation_for_member(
                    event=event,
                    member=participant.member,
                    submitted=True,
                )
            elif not participant.submitted and (
                "availability_inperson" in updates
                or "availability_virtual" in updates
                or updates.get("submitted") is False
            ):
                mark_invitation_for_member(
                    event=event,
                    member=participant.member,
                    draft_saved=True,
                )

        if is_versioned_mutation:
            expected_version = request.data.get("expectedVersion")
            if isinstance(expected_version, bool) or not isinstance(expected_version, int):
                return Response(
                    {
                        "error": "expectedVersion is required",
                        "errorCode": "participant_version_required",
                    },
                    status=428,
                )
            if participant.version != expected_version:
                if values_match():
                    track_unchanged_response()
                    return private_response({"participant": response_participant_payload()})
                return private_response(
                    {
                        "error": (
                            "Your availability changed in another session. "
                            "Refresh before saving again."
                        ),
                        "errorCode": "participant_version_conflict",
                        "participant": response_participant_payload(),
                    },
                    status=409,
                )

        if values_match():
            track_unchanged_response()
            timestamp_fields = []
            now = timezone.now()
            if participant.submitted and participant.first_submitted_at is None:
                participant.first_submitted_at = now
                participant.last_submitted_at = now
                timestamp_fields.extend(["first_submitted_at", "last_submitted_at"])
            elif (
                not participant.submitted
                and participant.first_draft_saved_at is None
                and (
                    "availability_inperson" in updates
                    or "availability_virtual" in updates
                    or updates.get("submitted") is False
                )
            ):
                participant.first_draft_saved_at = now
                timestamp_fields.append("first_draft_saved_at")
            if timestamp_fields:
                participant.save(update_fields=[*timestamp_fields, "updated_at"])
            return private_response({"participant": response_participant_payload()})

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
        elif participant.first_draft_saved_at is None and (
            "availability_inperson" in updates
            or "availability_virtual" in updates
            or updates.get("submitted") is False
        ):
            participant.first_draft_saved_at = now
            timestamp_fields.append("first_draft_saved_at")
        participant.version += 1
        participant.save(
            update_fields=[*updates.keys(), *timestamp_fields, "version", "updated_at"]
        )
        if updates.get("submitted"):
            mark_invitation_for_member(event=event, member=participant.member, submitted=True)
        elif not participant.submitted and (
            "availability_inperson" in updates
            or "availability_virtual" in updates
            or updates.get("submitted") is False
        ):
            if was_submitted:
                mark_invitation_response_withdrawn(event=event, member=participant.member)
            else:
                mark_invitation_for_member(
                    event=event,
                    member=participant.member,
                    draft_saved=True,
                )
        if organizer_can_edit_response and is_versioned_mutation:
            security_logger.info(
                "temporary_participant_organizer_updated",
                extra={
                    "event_id": str(event.pk),
                    "organizer_id": str(request.user.pk),
                    "member_id": str(participant.member_id),
                    "participant_version": participant.version,
                    "submitted": participant.submitted,
                },
            )
        if is_response_mutation:
            record_schedule_edit(
                event=event,
                participant=participant,
                actor=request.user,
                source=(
                    ScheduleEditRecord.Source.ORGANIZER
                    if organizer_can_edit_response
                    else ScheduleEditRecord.Source.SELF
                ),
                was_submitted=was_submitted,
            )
            request_event_results_recompute(event)
        return private_response({"participant": response_participant_payload()})

    @transaction.atomic
    def delete(self, request):
        event, participant, error = self._get_event_participant(request)
        if error:
            return error
        if event.organizer_id != request.user.pk:
            return Response({"error": "Only the organizer can hide participants"}, status=403)
        write_error = response_write_error(event)
        if write_error:
            return Response({"error": write_error}, status=409)
        participant.hidden = True
        participant.version += 1
        participant.save(update_fields=["hidden", "version", "updated_at"])
        request_event_results_recompute(event)
        return Response({"success": True})
