"""Inspect and retry an email delivery request."""

from django.db import transaction
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.scheduling.models import Event, FinalMeeting
from apps.scheduling.payloads.delivery import delivery_request_status_payload
from apps.scheduling.services.email_previews import delivery_job_preview
from apps.scheduling.services.invitations.previews import no_email_preview

from .helpers import private_response


def _calendar_job_sequence(job: EmailDeliveryJob, *, prefix: str, event: Event) -> int | None:
    parts = job.idempotency_key.split(":")
    if len(parts) != 4 or parts[0] != prefix or parts[1] != str(event.event_id):
        return None
    try:
        return int(parts[2])
    except ValueError:
        return None


def _failed_jobs(delivery_request: EmailDeliveryRequest) -> list[EmailDeliveryJob]:
    """The request's permanently failed emails, locked, in the order a retry queues them."""

    return list(
        delivery_request.jobs.select_for_update(of=("self",))
        .select_related("invitation")
        .filter(status=EmailDeliveryJob.Status.PERMANENT_FAILURE)
        .order_by("pk")
    )


def _retry_preview(event: Event, jobs: list[EmailDeliveryJob], eligible_ids, obsolete_ids):
    """What a retry would do with ``jobs``, and the first email it would send again."""

    eligible = set(eligible_ids)
    first = next((job for job in jobs if job.pk in eligible), None)
    return {
        "preview": True,
        "retryable": len(eligible_ids),
        "obsolete": len(obsolete_ids),
        **(delivery_job_preview(event, first) if first is not None else no_email_preview()),
    }


def _retryable_job_ids(
    *,
    event: Event,
    delivery_request: EmailDeliveryRequest,
    jobs: list[EmailDeliveryJob],
) -> tuple[list, list]:
    eligible = []
    obsolete = []
    operation = delivery_request.operation
    if operation in {
        EmailDeliveryRequest.Operation.INVITATION,
        EmailDeliveryRequest.Operation.REMINDER,
    }:
        active_member_ids = set(
            event.participants.filter(hidden=False).values_list("member_id", flat=True)
        )
        expected_type = (
            EmailMessageLog.MessageType.INVITATION
            if operation == EmailDeliveryRequest.Operation.INVITATION
            else EmailMessageLog.MessageType.REMINDER
        )
        for job in jobs:
            invitation = job.invitation
            is_current = bool(
                event.status == Event.Status.ACTIVE
                and job.message_type == expected_type
                and invitation is not None
                and invitation.event_id == event.pk
                and invitation.member_id in active_member_ids
            )
            (eligible if is_current else obsolete).append(job.pk)
        return eligible, obsolete

    meeting = FinalMeeting.objects.select_for_update().filter(event=event).first()
    if operation == EmailDeliveryRequest.Operation.FINAL_CONFIRMATION:
        expected_type = EmailMessageLog.MessageType.FINAL_CONFIRMATION
        prefix = "final-confirmation"
        meeting_is_current = bool(meeting is not None and meeting.active)
    else:
        expected_type = EmailMessageLog.MessageType.FINAL_CANCELLATION
        prefix = "final-cancellation"
        meeting_is_current = bool(meeting is not None and not meeting.active)
    for job in jobs:
        sequence = _calendar_job_sequence(job, prefix=prefix, event=event)
        is_current = bool(
            meeting_is_current
            and job.message_type == expected_type
            and sequence == meeting.calendar_sequence
        )
        (eligible if is_current else obsolete).append(job.pk)
    return eligible, obsolete


class DeliveryRequestView(APIView):
    permission_classes = [IsAuthenticated]

    def _request(self, request, request_id):
        delivery_request = (
            EmailDeliveryRequest.objects.select_related("event").filter(pk=request_id).first()
        )
        if delivery_request is None:
            return None, Response({"error": "Delivery request not found"}, status=404)
        if delivery_request.event.organizer_id != request.user.pk:
            return None, Response({"error": "Delivery request not found"}, status=404)
        return delivery_request, None

    def get(self, request, request_id):
        delivery_request, error = self._request(request, request_id)
        if error:
            return error
        return private_response(
            {"deliveryRequest": delivery_request_status_payload(delivery_request)}
        )

    @transaction.atomic
    def post(self, request, request_id):
        request_ref = EmailDeliveryRequest.objects.filter(pk=request_id).values("event_id").first()
        if request_ref is None:
            return Response({"error": "Delivery request not found"}, status=404)
        event = Event.objects.select_for_update().filter(pk=request_ref["event_id"]).first()
        delivery_request = (
            EmailDeliveryRequest.objects.select_for_update()
            .filter(pk=request_id, event=event)
            .first()
        )
        if delivery_request is None or event.organizer_id != request.user.pk:
            return Response({"error": "Delivery request not found"}, status=404)
        preview = request.data.get("preview", False)
        if not isinstance(preview, bool):
            return Response({"error": "preview must be a boolean."}, status=400)
        retryable = _failed_jobs(delivery_request)
        eligible_ids, obsolete_ids = _retryable_job_ids(
            event=event,
            delivery_request=delivery_request,
            jobs=retryable,
        )
        if preview:
            # The same failed emails and the same rules as the retry below;
            # nothing is requeued, canceled, or touched.
            return private_response(_retry_preview(event, retryable, eligible_ids, obsolete_ids))
        current_time = timezone.now()
        canceled = 0
        if obsolete_ids:
            canceled = EmailDeliveryJob.objects.filter(pk__in=obsolete_ids).update(
                status=EmailDeliveryJob.Status.CANCELED,
                last_error="This delivery request was superseded by the event's current state.",
                locked_at=None,
                lock_token=None,
                updated_at=current_time,
            )
        retried = 0
        if eligible_ids:
            retried = EmailDeliveryJob.objects.filter(pk__in=eligible_ids).update(
                status=EmailDeliveryJob.Status.PENDING,
                attempt_count=0,
                next_attempt_at=current_time,
                last_error="",
                locked_at=None,
                lock_token=None,
                updated_at=current_time,
            )
        delivery_request.updated_at = timezone.now()
        delivery_request.save(update_fields=["updated_at"])
        delivery_request._prefetched_objects_cache = {}
        if obsolete_ids and not eligible_ids:
            return private_response(
                {
                    "error": "This delivery request is no longer current for the event.",
                    "deliveryRequest": delivery_request_status_payload(delivery_request),
                    "retried": 0,
                    "canceled": canceled,
                },
                status=409,
            )
        return private_response(
            {
                "deliveryRequest": delivery_request_status_payload(delivery_request),
                "retried": retried,
                "canceled": canceled,
            },
            status=202,
        )
