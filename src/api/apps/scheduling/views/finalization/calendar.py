"""Download the calendar invitation for a confirmed meeting."""

from django.http import HttpResponse
from django.utils.cache import patch_cache_control, patch_vary_headers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.models import ContactEmail
from apps.scheduling.models import Event
from apps.scheduling.services.ics import final_meeting_ics


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
