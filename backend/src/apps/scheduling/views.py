import re

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.messaging.services import EmailDeliveryError
from apps.scheduling.models import Event, Participant, UserEvent, Weight
from apps.scheduling.services import (
    api_invitation,
    mark_invitation_for_member,
    send_event_reminders,
    split_invitation_emails,
    upsert_and_send_invitations,
)
from apps.scheduling.utils import (
    api_event,
    api_participant,
    api_weight,
    default_schedule,
    generate_event_code,
    schedule_to_storage,
    validate_schedule,
)


@api_view(["GET"])
@permission_classes([AllowAny])
def health(request):
    return Response({"ok": True})


class EventsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        return Response({"event": api_event(event)})

    @transaction.atomic
    def post(self, request):
        data = request.data
        name = str(data.get("name") or "").strip()
        if not name:
            return Response({"error": "Name is required"}, status=400)
        if len(name) > 200:
            return Response({"error": "Event name too long (max 200)"}, status=400)

        start = data.get("startHour", 9)
        end = data.get("endHour", 17)
        if not isinstance(start, int) or not isinstance(end, int):
            return Response({"error": "Hours must be integers"}, status=400)
        if start >= end or start < 0 or end > 24:
            return Response({"error": "Invalid time range"}, status=400)

        selected_days = (
            data.get("days")
            if isinstance(data.get("days"), list) and data.get("days")
            else [1, 2, 3, 4, 5]
        )
        if not all(isinstance(day, int) and 0 <= day <= 6 for day in selected_days):
            return Response({"error": "Days must be integers 0-6"}, status=400)

        mode = data.get("mode") or "inperson"
        if mode not in {"virtual", "inperson", "mixed"}:
            return Response(
                {"error": "Invalid mode. Must be 'inperson', 'virtual', or 'mixed'"}, status=400
            )
        location = "" if mode == "virtual" else (str(data.get("location") or "").strip() or "TBD")
        if len(location) > 500:
            return Response({"error": "Location too long (max 500)"}, status=400)

        day_selection_type = data.get("daySelectionType") or "days_of_week"
        if day_selection_type not in {"days_of_week", "specific_dates"}:
            return Response({"error": "Invalid daySelectionType"}, status=400)
        specific_dates = data.get("specificDates")
        if day_selection_type == "specific_dates":
            if not isinstance(specific_dates, list) or not specific_dates:
                return Response({"error": "specificDates must be a non-empty array"}, status=400)
            if not all(
                isinstance(item, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", item)
                for item in specific_dates
            ):
                return Response(
                    {"error": "specificDates must be ISO date strings (YYYY-MM-DD)"}, status=400
                )
        else:
            specific_dates = None

        view_permission = data.get("participantViewPermission") or "own_only"
        if view_permission not in {"own_only", "all", "realtime"}:
            return Response({"error": "Invalid participantViewPermission value"}, status=400)

        response_deadline = None
        raw_deadline = data.get("responseDeadline")
        if raw_deadline:
            response_deadline = parse_datetime(str(raw_deadline))
            if response_deadline is None:
                return Response({"error": "responseDeadline must be an ISO datetime"}, status=400)
            if timezone.is_naive(response_deadline):
                response_deadline = timezone.make_aware(response_deadline)

        reminders_enabled = data.get("remindersEnabled", True)
        reminder_hours_before = data.get("reminderHoursBefore", 24)
        if not isinstance(reminders_enabled, bool):
            return Response({"error": "remindersEnabled must be a boolean"}, status=400)
        try:
            reminder_hours_before = int(reminder_hours_before)
        except (TypeError, ValueError):
            return Response({"error": "reminderHoursBefore must be an integer"}, status=400)
        if reminder_hours_before < 0 or reminder_hours_before > 720:
            return Response({"error": "reminderHoursBefore must be between 0 and 720"}, status=400)

        event = None
        for _ in range(3):
            code = generate_event_code()
            if not Event.objects.filter(code=code).exists():
                event = Event.objects.create(
                    code=code,
                    name=name,
                    start_hour=start,
                    end_hour=end,
                    days=selected_days,
                    mode=mode,
                    location=location,
                    organizer=request.user,
                    participant_view_permission=view_permission,
                    day_selection_type=day_selection_type,
                    specific_dates=specific_dates,
                    response_deadline=response_deadline,
                    reminders_enabled=reminders_enabled,
                    reminder_hours_before=reminder_hours_before,
                )
                break
        if event is None:
            return Response({"error": "Failed to generate unique code"}, status=500)

        UserEvent.objects.get_or_create(member=request.user, event=event, role="organizer")
        return Response({"event": api_event(event)}, status=201)


class ParticipantsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        participants = event.participants.select_related("event", "member").all()
        include_hidden = (
            request.query_params.get("includeHidden") == "true"
            and event.organizer_id == request.user.pk
        )
        if not include_hidden:
            participants = participants.filter(hidden=False)
        return Response(
            {"participants": [api_participant(participant) for participant in participants]}
        )

    @transaction.atomic
    def post(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)

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
                "schedule_inperson": default_schedule(event),
                "schedule_virtual": default_schedule(event),
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
        event = Event.objects.filter(code=code).first()
        if event is None:
            return None, None, Response({"error": "Event not found"}, status=404)
        participant = (
            event.participants.select_related("event", "member")
            .filter(member_id=participant_id)
            .first()
        )
        if participant is None:
            return event, None, Response({"error": "Participant not found"}, status=404)
        return event, participant, None

    def put(self, request):
        event, participant, error = self._get_event_participant(request)
        if error:
            return error

        is_organizer = event.organizer_id == request.user.pk
        is_self = participant.member_id == request.user.pk
        if not is_organizer and not is_self:
            return Response(
                {"error": "You do not have permission to update this participant"}, status=403
            )

        updates = {}
        for field, label in (
            ("scheduleInperson", "scheduleInperson"),
            ("scheduleVirtual", "scheduleVirtual"),
        ):
            if field in request.data:
                err = validate_schedule(request.data[field], event, label)
                if err:
                    return Response({"error": err}, status=400)
                target = "schedule_inperson" if field == "scheduleInperson" else "schedule_virtual"
                updates[target] = schedule_to_storage(request.data[field])

        if "submitted" in request.data:
            updates["submitted"] = bool(request.data["submitted"])

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
            updates["sort_order"] = (
                int(request.data["sortOrder"]) if request.data["sortOrder"] is not None else None
            )

        if not updates:
            return Response({"participant": api_participant(participant)})

        for key, value in updates.items():
            setattr(participant, key, value)
        participant.save(update_fields=[*updates.keys(), "updated_at"])
        if updates.get("submitted"):
            mark_invitation_for_member(event=event, member=participant.member, submitted=True)
        return Response({"participant": api_participant(participant)})

    def delete(self, request):
        event, participant, error = self._get_event_participant(request)
        if error:
            return error
        if event.organizer_id != request.user.pk:
            return Response({"error": "Only the organizer can hide participants"}, status=403)
        participant.hidden = True
        participant.save(update_fields=["hidden", "updated_at"])
        return Response({"success": True})


class ParticipantUnhideView(APIView):
    permission_classes = [IsAuthenticated]

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
        participant = (
            event.participants.select_related("event", "member")
            .filter(member_id=participant_id)
            .first()
        )
        if participant is None:
            return Response({"error": "Participant not found"}, status=404)
        participant.hidden = False
        participant.save(update_fields=["hidden", "updated_at"])
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
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response({"error": "Only the organizer can update weights"}, status=403)

        weights = request.data.get("weights")
        if not isinstance(weights, list):
            return Response({"error": "weights must be an array"}, status=400)

        participant_map = {
            str(participant.member_id): participant for participant in event.participants.all()
        }
        for item in weights:
            participant_id = item.get("participantId", item.get("id"))
            try:
                weight_value = float(item.get("weight", 1.0))
            except (TypeError, ValueError):
                return Response({"error": "Invalid weight entry"}, status=400)
            included = item.get("included", 1)
            if not participant_id or weight_value < 0 or weight_value > 1 or included not in {0, 1}:
                return Response({"error": "Invalid weight entry"}, status=400)
            participant = participant_map.get(str(participant_id))
            if participant is None:
                return Response({"error": f"Participant '{participant_id}' not found"}, status=400)
            Weight.objects.update_or_create(
                event=event,
                participant=participant,
                defaults={"weight": weight_value, "included": bool(included)},
            )

        updated = event.weights.select_related("participant", "participant__member").all()
        return Response({"weights": [api_weight(weight) for weight in updated]})


class DashboardEventsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        links = UserEvent.objects.select_related("event").filter(member=request.user)
        organized = []
        participating = []
        for link in links:
            if link.role == "organizer":
                organized.append(api_event(link.event))
            else:
                participating.append(api_event(link.event))
        return Response({"organized": organized, "participating": participating})


class EventInvitationsView(APIView):
    permission_classes = [IsAuthenticated]

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
        emails, invalid = split_invitation_emails(request.data.get("emails", []))
        if invalid:
            return Response({"error": f"Invalid email address: {invalid[0]}"}, status=400)
        if not emails:
            return Response({"error": "At least one email address is required"}, status=400)
        message = str(request.data.get("message", "") or "").strip()
        if len(message) > 1000:
            return Response({"error": "message is too long (max 1000)"}, status=400)
        try:
            invitations = upsert_and_send_invitations(
                event=event,
                emails=emails,
                invited_by=request.user,
                message=message,
            )
        except EmailDeliveryError as exc:
            return Response({"detail": str(exc)}, status=503)
        return Response(
            {"invitations": [api_invitation(invitation) for invitation in invitations]},
            status=201,
        )


class EventRemindersView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response({"error": "Only the organizer can send reminders"}, status=403)
        try:
            sent_count = send_event_reminders(event, force=True)
        except EmailDeliveryError as exc:
            return Response({"detail": str(exc)}, status=503)
        return Response({"sent": sent_count})
