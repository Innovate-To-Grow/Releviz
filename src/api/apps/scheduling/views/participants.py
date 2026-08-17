"""Joining an event, reading the participant list, and editing availability."""

import logging
import uuid

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import Throttled
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.security import AuthRateThrottle, consume_request_rate_limit
from apps.mail.models import EmailDeliveryRequest
from apps.scheduling.models import Event, Participant, ScheduleEditRecord, UserEvent
from apps.scheduling.permissions import (
    can_join_event,
    visible_participants_for_user,
    weight_for_participant,
)
from apps.scheduling.serializers import (
    api_participant,
    api_weight,
    email_delivery_request_payload,
    participant_summary,
)
from apps.scheduling.services.aggregation import participant_is_excluded
from apps.scheduling.services.deliveries import (
    EventEmailRequestError,
    create_or_reuse_managed_participant_and_send,
)
from apps.scheduling.services.invitations import (
    ManagedParticipantError,
    mark_invitation_for_member,
    mark_invitation_response_withdrawn,
)
from apps.scheduling.services.lifecycle import response_write_error
from apps.scheduling.services.result_snapshots import (
    mark_event_results_dirty,
    request_event_results_recompute,
)
from apps.scheduling.services.roster import apply_roster_filters, roster_queryset
from apps.scheduling.services.roster_imports import RosterImportError
from apps.scheduling.services.slots import default_availability, validate_availability
from apps.scheduling.views.helpers import (
    page_payload,
    parse_pagination,
    private_response,
    record_schedule_edit,
)

security_logger = logging.getLogger("releviz.security")


def organizer_participant_payload(participant, event):
    invitation = (
        event.invitations.filter(member_id=participant.member_id).order_by("-created_at").first()
    )
    return api_participant(
        participant,
        organizer_private=True,
        invitation=invitation,
    )


def organizer_response_write_error(event) -> str | None:
    """Organizers may fill temporary schedules outside the participant deadline."""

    if event.status != Event.Status.ACTIVE:
        return f"Organizer-entered responses cannot change while the event is {event.status}."
    if hasattr(event, "final_meeting") and event.final_meeting.active:
        return "Reopen the event before changing an organizer-entered response."
    return None


class ParticipantsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        include_hidden = (
            request.query_params.get("includeHidden") == "true"
            and event.organizer_id == request.user.pk
        )
        participants = visible_participants_for_user(
            event,
            request.user,
            include_hidden=include_hidden,
        )
        if participants is None:
            return Response(
                {"error": "You must join this event before viewing participants"},
                status=403,
            )
        is_organizer = event.organizer_id == request.user.pk
        if is_organizer:
            try:
                page, page_size = parse_pagination(request)
                roster = roster_queryset(event)
                if not include_hidden:
                    roster = roster.filter(hidden=False)
                roster = apply_roster_filters(roster, request.query_params)
            except RosterImportError as exc:
                return Response({"error": str(exc)}, status=exc.status_code)
            total = roster.count()
            offset = (page - 1) * page_size
            return private_response(
                {
                    "participants": [
                        participant_summary(participant)
                        for participant in roster[offset : offset + page_size]
                    ],
                    "pagination": page_payload(
                        page=page,
                        page_size=page_size,
                        total=total,
                    ),
                    "scheduleDataIncluded": False,
                }
            )
        own_participant = next(
            (
                participant
                for participant in participants
                if participant.member_id == request.user.pk
            ),
            None,
        )
        return private_response(
            {
                "participants": (
                    [api_participant(own_participant)] if own_participant is not None else []
                ),
                "scheduleDataIncluded": own_participant is not None,
            }
        )

    @transaction.atomic
    def post(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.select_for_update().filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if not can_join_event(event, request.user):
            return Response(
                {"error": "This event is limited to invited participants"},
                status=403,
            )
        write_error = response_write_error(event)
        if write_error:
            return Response({"error": write_error}, status=409)

        participant_limit = getattr(settings, "EVENT_MAX_PARTICIPANTS", 1000)
        if (
            not event.participants.filter(member=request.user).exists()
            and event.participants.count() >= participant_limit
        ):
            return Response(
                {"error": f"This event can have at most {participant_limit} participants"},
                status=409,
            )

        name = request.user.display_name().strip()
        if not name:
            return Response({"error": "Name is required"}, status=400)
        if len(name) > 100:
            return Response({"error": "Name too long (max 100)"}, status=400)

        participant, created = Participant.objects.get_or_create(
            event=event,
            member=request.user,
            defaults={
                "participant_name": name,
                "availability_inperson": default_availability(event),
                "availability_virtual": default_availability(event),
            },
        )
        if participant.participant_name != name:
            participant.participant_name = name
            participant.save(update_fields=["participant_name", "updated_at"])

        if event.organizer_id != request.user.pk:
            UserEvent.objects.get_or_create(member=request.user, event=event, role="participant")
        mark_invitation_for_member(event=event, member=request.user)
        if created:
            mark_event_results_dirty(event)

        return Response(
            {"participant": api_participant(participant)},
            status=201 if created else 200,
        )


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


class ParticipantUnhideView(APIView):
    permission_classes = [IsAuthenticated]

    @transaction.atomic
    def put(self, request):
        code = request.query_params.get("code", "")
        participant_id = request.query_params.get("participantId", "")
        if not code or not participant_id:
            return Response({"error": "code and participantId are required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response({"error": "Only the organizer can unhide participants"}, status=403)
        write_error = response_write_error(event)
        if write_error:
            return Response({"error": write_error}, status=409)
        participant = (
            event.participants.select_related("event", "member")
            .filter(member_id=participant_id)
            .first()
        )
        if participant is None:
            return Response({"error": "Participant not found"}, status=404)
        participant.hidden = False
        participant.version += 1
        participant.save(update_fields=["hidden", "version", "updated_at"])
        request_event_results_recompute(event)
        return Response({"participant": api_participant(participant)})


class WeightsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response({"error": "Only the organizer can view weights"}, status=403)
        weights = event.weights.select_related("participant", "participant__member").all()
        return private_response({"weights": [api_weight(weight) for weight in weights]})

    def put(self, request):
        return Response(
            {
                "error": (
                    "Bulk weight replacement was removed. Use PATCH /events/roster/{id} "
                    "or PATCH /events/roster/bulk."
                )
            },
            status=405,
        )
