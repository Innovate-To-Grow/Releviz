import logging
import uuid

from django.conf import settings
from django.db import DatabaseError, connection, transaction
from django.http import HttpResponse
from django.utils import timezone
from django.utils.cache import patch_cache_control, patch_vary_headers
from django.utils.dateparse import parse_datetime
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import Throttled
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.models import ContactEmail
from apps.authn.security import AuthRateThrottle, consume_request_rate_limit
from apps.messaging.models import EmailDeliveryRequest
from apps.messaging.services import (
    dispatch_email_job,
    email_delivery_summary,
)
from apps.scheduling.aggregation import build_event_results, participant_is_excluded
from apps.scheduling.event_management import (
    EventManagementError,
    create_event,
    delete_event,
    duplicate_event,
    update_event,
)
from apps.scheduling.finalization import (
    FinalizationError,
    build_attendance_review,
    cancel_active_final_meeting,
    confirm_final_meeting,
    final_delivery_summary,
    normalize_final_time,
)
from apps.scheduling.lifecycle import (
    LifecycleError,
    event_configuration_write_error,
    response_write_error,
    transition_event,
)
from apps.scheduling.models import Event, Participant, UserEvent, Weight
from apps.scheduling.permissions import (
    can_view_event_results,
    visible_participants_for_user,
    weight_for_participant,
)
from apps.scheduling.services import (
    EventEmailRequestError,
    api_invitation,
    enqueue_manual_reminders,
    final_meeting_ics,
    mark_invitation_for_member,
    mark_invitation_opened,
    mark_invitation_response_withdrawn,
    split_invitation_emails,
    upsert_and_send_invitations,
)
from apps.scheduling.utils import (
    api_event,
    api_final_meeting,
    api_participant,
    api_weight,
    default_availability,
    validate_availability,
)

logger = logging.getLogger(__name__)


def private_response(data, *, status=200):
    response = Response(data, status=status)
    patch_cache_control(response, private=True, no_store=True)
    patch_vary_headers(response, ["Authorization"])
    return response


def parse_aware_timestamp(value, label: str):
    if not isinstance(value, str):
        return None, Response({"error": f"{label} must be an ISO datetime"}, status=400)
    parsed = parse_datetime(value)
    if parsed is None:
        return None, Response({"error": f"{label} must be an ISO datetime"}, status=400)
    if timezone.is_naive(parsed):
        return None, Response(
            {"error": f"{label} must include an explicit UTC offset"},
            status=400,
        )
    return parsed, None


def event_management_error_response(exc):
    payload = {"error": str(exc), **exc.extra}
    if exc.event is not None:
        payload["event"] = api_event(exc.event)
    return private_response(payload, status=exc.status_code)


@api_view(["GET"])
@permission_classes([AllowAny])
def health_live(request):
    response = Response({"ok": True})
    patch_cache_control(response, no_store=True)
    return response


@api_view(["GET"])
@permission_classes([AllowAny])
def health_ready(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except DatabaseError:
        logger.warning("readiness_check_failed", exc_info=True)
        response = Response(
            {"ok": False, "checks": {"database": "unavailable"}},
            status=503,
        )
    else:
        response = Response({"ok": True, "checks": {"database": "ok"}})
    patch_cache_control(response, no_store=True)
    return response


class EventsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.select_related("final_meeting").filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        return Response({"event": api_event(event)})

    def post(self, request):
        try:
            event = create_event(organizer=request.user, data=request.data)
        except EventManagementError as exc:
            return event_management_error_response(exc)
        return private_response({"event": api_event(event)}, status=201)

    def put(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        try:
            result = update_event(
                organizer=request.user,
                code=code,
                data=request.data,
            )
        except EventManagementError as exc:
            return event_management_error_response(exc)
        return private_response(
            {
                "event": api_event(result.event),
                "responsesReset": result.responses_reset,
                "idempotent": result.idempotent,
            }
        )

    def delete(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        try:
            result = delete_event(
                organizer=request.user,
                code=code,
                data=request.data,
            )
        except EventManagementError as exc:
            return event_management_error_response(exc)
        return private_response(
            {
                "deletedCode": result.code,
                "idempotent": result.idempotent,
            }
        )


class EventDuplicateView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        try:
            result = duplicate_event(
                organizer=request.user,
                code=code,
                data=request.data,
            )
        except EventManagementError as exc:
            return event_management_error_response(exc)
        return private_response(
            {
                "event": api_event(result.event),
                "idempotent": result.idempotent,
            },
            status=200 if result.idempotent else 201,
        )


class EventLifecycleView(APIView):
    permission_classes = [IsAuthenticated]

    @transaction.atomic
    def put(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.select_for_update().filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response(
                {"error": "Only the organizer can change event lifecycle"},
                status=403,
            )

        expected_version = request.data.get("expectedVersion")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int):
            return Response({"error": "expectedVersion is required"}, status=428)

        target_status = str(request.data.get("status") or "").strip()
        deadline = event.response_deadline
        if "responseDeadline" in request.data:
            raw_deadline = request.data.get("responseDeadline")
            if raw_deadline is None or raw_deadline == "":
                deadline = None
            else:
                deadline = parse_datetime(str(raw_deadline))
                if deadline is None:
                    return Response(
                        {"error": "responseDeadline must be an ISO datetime"},
                        status=400,
                    )
                if timezone.is_naive(deadline):
                    deadline = timezone.make_aware(deadline)

        if event.version != expected_version:
            if target_status == event.status and deadline == event.response_deadline:
                return private_response({"event": api_event(event)})
            return private_response(
                {
                    "error": "The event changed in another session. Refresh and try again.",
                    "event": api_event(event),
                },
                status=409,
            )

        try:
            changed_fields = transition_event(
                event,
                target_status,
                response_deadline=deadline,
            )
        except LifecycleError as exc:
            return Response({"error": str(exc)}, status=400)
        if changed_fields:
            event.save(update_fields=changed_fields)
        cancellation_jobs = []
        if target_status == Event.Status.OPEN and "status" in changed_fields:
            cancellation_jobs = cancel_active_final_meeting(event)
        if cancellation_jobs:
            job_ids = [job.pk for job in cancellation_jobs]
            transaction.on_commit(
                lambda: [dispatch_email_job(job_id) for job_id in job_ids],
                robust=True,
            )
        return private_response({"event": api_event(event)})


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
        return private_response(
            {"participants": [api_participant(participant) for participant in participants]}
        )

    @transaction.atomic
    def post(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.select_for_update().filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        write_error = response_write_error(event)
        if write_error:
            return Response({"error": write_error}, status=409)

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

        return Response(
            {"participant": api_participant(participant)},
            status=201 if created else 200,
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
        event = Event.objects.select_for_update().filter(code=code).first()
        if event is None:
            return None, None, Response({"error": "Event not found"}, status=404)
        participants = event.participants.select_related("event", "member").select_for_update()
        participant = participants.filter(member_id=participant_id).first()
        if participant is None:
            return event, None, Response({"error": "Participant not found"}, status=404)
        return event, participant, None

    @transaction.atomic
    def put(self, request):
        event, participant, error = self._get_event_participant(request)
        if error:
            return error

        is_organizer = event.organizer_id == request.user.pk
        is_self = participant.member_id == request.user.pk
        response_fields = {"availabilityInperson", "availabilityVirtual", "submitted"}
        is_response_mutation = any(field in request.data for field in response_fields)
        if is_response_mutation and not is_self:
            return Response(
                {"error": "Only participants can change their own availability"},
                status=403,
            )
        if not is_organizer and not is_self:
            return Response(
                {"error": "You do not have permission to update this participant"}, status=403
            )
        if is_response_mutation:
            write_error = response_write_error(event)
            if write_error:
                return Response({"error": write_error}, status=409)
            weight = weight_for_participant(event, participant)
            if participant_is_excluded(participant, weight):
                return Response(
                    {"error": "Excluded participants cannot change availability"},
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

        if "submitted" in request.data:
            submitted = request.data["submitted"]
            if submitted not in {0, 1}:
                return Response({"error": "submitted must be a boolean"}, status=400)
            updates["submitted"] = bool(submitted)

        if "groupName" in request.data:
            if not is_organizer:
                return Response(
                    {"error": "Only the organizer can update participant groups"}, status=403
                )
            updates["group_name"] = request.data.get("groupName") or None

        if "sortOrder" in request.data:
            if not is_organizer:
                return Response(
                    {"error": "Only the organizer can reorder participants"}, status=403
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
            return private_response({"participant": api_participant(participant)})

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

        if is_response_mutation:
            expected_version = request.data.get("expectedVersion")
            if isinstance(expected_version, bool) or not isinstance(expected_version, int):
                return Response({"error": "expectedVersion is required"}, status=428)
            if participant.version != expected_version:
                if values_match():
                    track_unchanged_response()
                    return private_response({"participant": api_participant(participant)})
                return private_response(
                    {
                        "error": (
                            "Your availability changed in another session. "
                            "Refresh before saving again."
                        ),
                        "participant": api_participant(participant),
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
            return private_response({"participant": api_participant(participant)})

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
        return private_response({"participant": api_participant(participant)})

    @transaction.atomic
    def delete(self, request):
        event, participant, error = self._get_event_participant(request)
        if error:
            return error
        if event.organizer_id != request.user.pk:
            return Response({"error": "Only the organizer can hide participants"}, status=403)
        write_error = event_configuration_write_error(event)
        if write_error:
            return Response({"error": write_error}, status=409)
        participant.hidden = True
        participant.version += 1
        participant.save(update_fields=["hidden", "version", "updated_at"])
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
        write_error = event_configuration_write_error(event)
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
        return Response({"weights": [api_weight(weight) for weight in weights]})

    @transaction.atomic
    def put(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.select_for_update().filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response({"error": "Only the organizer can update weights"}, status=403)
        write_error = event_configuration_write_error(event)
        if write_error:
            return Response({"error": write_error}, status=409)

        weights = request.data.get("weights")
        if not isinstance(weights, list):
            return Response({"error": "weights must be an array"}, status=400)

        participants = list(event.participants.all())
        participant_map = {str(participant.member_id): participant for participant in participants}
        existing_weights = {
            weight.participant_id: weight
            for weight in event.weights.filter(participant__in=participants)
        }
        for item in weights:
            if not isinstance(item, dict):
                return Response({"error": "Invalid weight entry"}, status=400)
            participant_id = item.get("participantId", item.get("id"))
            participant = participant_map.get(str(participant_id))
            if participant is None:
                return Response({"error": f"Participant '{participant_id}' not found"}, status=400)
            existing = existing_weights.get(participant.pk)
            try:
                weight_value = float(
                    item.get("weight", existing.weight if existing is not None else 1.0)
                )
            except (TypeError, ValueError):
                return Response({"error": "Invalid weight entry"}, status=400)
            included = item.get(
                "included",
                int(existing.included) if existing is not None else 1,
            )
            required = item.get(
                "required",
                int(existing.required) if existing is not None else 0,
            )
            if (
                weight_value < 0
                or weight_value > 1
                or included not in {0, 1}
                or required not in {0, 1}
            ):
                return Response({"error": "Invalid weight entry"}, status=400)
            Weight.objects.update_or_create(
                event=event,
                participant=participant,
                defaults={
                    "weight": weight_value,
                    "included": bool(included),
                    "required": bool(required),
                },
            )

        updated = event.weights.select_related("participant", "participant__member").all()
        return Response(
            {
                "weights": [api_weight(weight) for weight in updated],
                "results": build_event_results(event),
            }
        )


class EventResultsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if not can_view_event_results(event, request.user):
            return Response(
                {"error": "You do not have permission to view event results"},
                status=403,
            )
        return private_response({"results": build_event_results(event)})


class DashboardEventsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        links = UserEvent.objects.select_related("event").filter(member=request.user)
        organized = []
        participating = []
        for link in links:
            if link.role == "organizer":
                organized.append(api_event(link.event, include_slot_groups=False))
            else:
                participating.append(api_event(link.event, include_slot_groups=False))
        return Response({"organized": organized, "participating": participating})


class EventInvitationOpenView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        code = str(request.data.get("code") or "").strip()
        try:
            access_token = uuid.UUID(str(request.data.get("token") or ""))
        except (ValueError, TypeError, AttributeError):
            access_token = None
        if code and access_token:
            mark_invitation_opened(event_code=code, access_token=access_token)
        response = Response(status=204)
        patch_cache_control(response, private=True, no_store=True)
        return response


class EventInvitationsView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [AuthRateThrottle]
    auth_rate_scope = "invitation_request"
    auth_rate_methods = {"POST"}

    def get_auth_rate_identity(self, request):
        return str(request.user.pk)

    def _event_for_organizer(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return None, Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return None, Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return None, Response(
                {"error": "Only the organizer can manage invitations"},
                status=403,
            )
        return event, None

    def get(self, request):
        event, error = self._event_for_organizer(request)
        if error:
            return error
        invitations = event.invitations.select_related("member").all()
        return Response({"invitations": [api_invitation(invitation) for invitation in invitations]})

    def post(self, request):
        event, error = self._event_for_organizer(request)
        if error:
            return error
        write_error = event_configuration_write_error(event)
        if write_error:
            return Response({"error": write_error}, status=409)
        try:
            idempotency_key = uuid.UUID(str(request.data.get("idempotencyKey") or ""))
        except (ValueError, TypeError, AttributeError):
            return Response({"error": "idempotencyKey must be a UUID"}, status=400)
        emails, invalid = split_invitation_emails(request.data.get("emails", []))
        if invalid:
            return Response({"error": f"Invalid email address: {invalid[0]}"}, status=400)
        if not emails:
            return Response({"error": "At least one email address is required"}, status=400)
        if len(emails) > settings.INVITATION_MAX_BATCH_SIZE:
            return Response(
                {
                    "error": (
                        "Too many invitation recipients; "
                        f"send at most {settings.INVITATION_MAX_BATCH_SIZE} at once."
                    )
                },
                status=400,
            )
        message = str(request.data.get("message", "") or "").strip()
        if len(message) > 1000:
            return Response({"error": "message is too long (max 1000)"}, status=400)

        is_replay = EmailDeliveryRequest.objects.filter(
            event=event,
            operation=EmailDeliveryRequest.Operation.INVITATION,
            idempotency_key=idempotency_key,
        ).exists()
        if not is_replay:
            quota = consume_request_rate_limit(
                "invitation_recipient",
                request,
                str(request.user.pk),
                cost=len(emails),
            )
            if not quota.allowed:
                raise Throttled(wait=quota.retry_after)

        try:
            result = upsert_and_send_invitations(
                event=event,
                emails=emails,
                invited_by=request.user,
                idempotency_key=idempotency_key,
                message=message,
            )
        except EventEmailRequestError as exc:
            return Response({"error": str(exc)}, status=exc.status_code)

        for job in result["jobs"]:
            dispatch_email_job(job.pk)
            job.refresh_from_db()
        for invitation in result["invitations"]:
            invitation.refresh_from_db()
        delivery = email_delivery_summary(result["jobs"])
        recipient_count = result["request"].recipient_count
        return Response(
            {
                "invitations": [api_invitation(invitation) for invitation in result["invitations"]],
                "delivery": delivery,
                "recipientCount": recipient_count,
                "enqueued": result["createdJobCount"],
                "deduplicated": recipient_count - result["createdJobCount"],
                "idempotent": result["idempotent"],
            },
            status=200 if result["idempotent"] else 201,
        )


class EventRemindersView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [AuthRateThrottle]
    auth_rate_scope = "reminder_request"
    auth_rate_methods = {"POST"}

    def get_auth_rate_identity(self, request):
        return str(request.user.pk)

    def post(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response({"error": "Only the organizer can send reminders"}, status=403)
        write_error = event_configuration_write_error(event)
        if write_error:
            return Response({"error": write_error}, status=409)
        try:
            idempotency_key = uuid.UUID(str(request.data.get("idempotencyKey") or ""))
        except (ValueError, TypeError, AttributeError):
            return Response({"error": "idempotencyKey must be a UUID"}, status=400)

        recipient_count = (
            event.invitations.exclude(status="submitted").count() if event.reminders_enabled else 0
        )
        is_replay = EmailDeliveryRequest.objects.filter(
            event=event,
            operation=EmailDeliveryRequest.Operation.REMINDER,
            idempotency_key=idempotency_key,
        ).exists()
        if recipient_count and not is_replay:
            quota = consume_request_rate_limit(
                "reminder_recipient",
                request,
                str(request.user.pk),
                cost=recipient_count,
            )
            if not quota.allowed:
                raise Throttled(wait=quota.retry_after)

        try:
            result = enqueue_manual_reminders(
                event=event,
                requested_by=request.user,
                idempotency_key=idempotency_key,
            )
        except EventEmailRequestError as exc:
            return Response({"error": str(exc)}, status=exc.status_code)

        for job in result["jobs"]:
            dispatch_email_job(job.pk)
            job.refresh_from_db()
        delivery = email_delivery_summary(result["jobs"])
        recipient_count = result["request"].recipient_count
        return Response(
            {
                "sent": delivery["sent"],
                "delivery": delivery,
                "recipientCount": recipient_count,
                "enqueued": result["createdJobCount"],
                "deduplicated": recipient_count - result["createdJobCount"],
                "idempotent": result["idempotent"],
            }
        )


class EventFinalizationPreviewView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response(
                {"error": "Only the organizer can review a final meeting time"},
                status=403,
            )
        if event.status not in {Event.Status.OPEN, Event.Status.CLOSED}:
            return Response(
                {"error": f"An event cannot be finalized while it is {event.status}."},
                status=409,
            )
        starts_at, error = parse_aware_timestamp(request.data.get("startsAt"), "startsAt")
        if error:
            return error
        ends_at, error = parse_aware_timestamp(request.data.get("endsAt"), "endsAt")
        if error:
            return error
        try:
            normalized = normalize_final_time(
                event,
                starts_at=starts_at,
                ends_at=ends_at,
                channel=str(request.data.get("channel") or "").strip(),
                location=str(request.data.get("location") or ""),
            )
        except FinalizationError as exc:
            return Response({"error": str(exc)}, status=exc.status_code)
        return private_response(
            {
                "eventVersion": event.version,
                "proposedMeeting": {
                    "startsAt": normalized["starts_at"].isoformat(),
                    "endsAt": normalized["ends_at"].isoformat(),
                    "timezone": event.timezone,
                    "channel": normalized["channel"],
                    "location": normalized["location"],
                },
                "attendance": build_attendance_review(event, normalized),
            }
        )


class EventFinalizationView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.select_related("final_meeting").filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response(
                {"error": "Only the organizer can view finalization details"},
                status=403,
            )
        meeting = getattr(event, "final_meeting", None)
        if meeting is None:
            return Response({"error": "No final meeting has been confirmed"}, status=404)
        return private_response(
            {
                "event": api_event(event),
                "finalMeeting": api_final_meeting(meeting, include_attendance=True),
                "delivery": final_delivery_summary(event, meeting),
            }
        )

    def put(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        expected_version = request.data.get("expectedVersion")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int):
            return Response({"error": "expectedVersion is required"}, status=428)
        try:
            idempotency_key = uuid.UUID(str(request.data.get("idempotencyKey") or ""))
        except (ValueError, TypeError, AttributeError):
            return Response({"error": "idempotencyKey must be a UUID"}, status=400)
        starts_at, error = parse_aware_timestamp(request.data.get("startsAt"), "startsAt")
        if error:
            return error
        ends_at, error = parse_aware_timestamp(request.data.get("endsAt"), "endsAt")
        if error:
            return error

        try:
            result = confirm_final_meeting(
                event_code=code,
                organizer=request.user,
                expected_version=expected_version,
                idempotency_key=idempotency_key,
                starts_at=starts_at,
                ends_at=ends_at,
                channel=str(request.data.get("channel") or "").strip(),
                location=str(request.data.get("location") or ""),
            )
        except FinalizationError as exc:
            return private_response({"error": str(exc)}, status=exc.status_code)

        for job in result["jobs"]:
            dispatch_email_job(job.pk)
        result["event"].refresh_from_db()
        result["meeting"].refresh_from_db()
        return private_response(
            {
                "event": api_event(result["event"]),
                "finalMeeting": api_final_meeting(
                    result["meeting"],
                    include_attendance=True,
                ),
                "delivery": final_delivery_summary(result["event"], result["meeting"]),
                "idempotent": result["idempotent"],
            }
        )


class EventFinalCalendarView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.select_related("final_meeting").filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        member_emails = ContactEmail.objects.filter(
            member=request.user,
            verified=True,
        ).values_list("email_address", flat=True)
        authorized = (
            event.organizer_id == request.user.pk
            or event.participants.filter(member=request.user, hidden=False).exists()
            or event.invitations.filter(member=request.user).exists()
            or event.invitations.filter(email__in=member_emails).exists()
        )
        if not authorized:
            return Response(
                {"error": "You do not have access to this calendar invitation"},
                status=403,
            )
        meeting = getattr(event, "final_meeting", None)
        if meeting is None or not meeting.active:
            return Response({"error": "No active final meeting has been confirmed"}, status=404)
        attachment = final_meeting_ics(event, meeting)
        response = HttpResponse(attachment.content, content_type=attachment.mimetype)
        response["Content-Disposition"] = f'attachment; filename="{attachment.filename}"'
        patch_cache_control(response, private=True, no_store=True)
        patch_vary_headers(response, ["Authorization"])
        return response
