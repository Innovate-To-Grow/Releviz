"""API payloads for email delivery requests."""

from django.db.models import Count

from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest
from apps.mail.services import email_delivery_summary


def email_delivery_request_payload(
    request_record: EmailDeliveryRequest | None,
    *,
    jobs=None,
) -> dict | None:
    if request_record is None:
        return None
    delivery_jobs = list(jobs) if jobs is not None else list(request_record.jobs.all())
    return {
        "id": str(request_record.pk),
        "operation": request_record.operation,
        "recipientCount": request_record.recipient_count,
        "enqueued": request_record.created_job_count,
        "createdAt": request_record.created_at.isoformat(),
        "updatedAt": request_record.updated_at.isoformat(),
        "delivery": email_delivery_summary(delivery_jobs),
    }


def delivery_request_status_payload(request_record: EmailDeliveryRequest) -> dict:
    """Same shape as ``email_delivery_request_payload``, counted in the database.

    Operational reads report on requests whose jobs are not already loaded, so
    the per-status totals are aggregated instead of summarized in Python.
    """

    status_counts = {
        row["status"]: row["total"]
        for row in request_record.jobs.values("status").annotate(total=Count("pk"))
    }
    return {
        "id": str(request_record.pk),
        "operation": request_record.operation,
        "recipientCount": request_record.recipient_count,
        "enqueued": request_record.created_job_count,
        "createdAt": request_record.created_at.isoformat(),
        "updatedAt": request_record.updated_at.isoformat(),
        "delivery": {
            "total": sum(status_counts.values()),
            "pending": status_counts.get(EmailDeliveryJob.Status.PENDING, 0),
            "processing": status_counts.get(EmailDeliveryJob.Status.PROCESSING, 0),
            "retry": status_counts.get(EmailDeliveryJob.Status.RETRY, 0),
            "sent": status_counts.get(EmailDeliveryJob.Status.SENT, 0),
            "permanentFailure": status_counts.get(
                EmailDeliveryJob.Status.PERMANENT_FAILURE,
                0,
            ),
            "canceled": status_counts.get(EmailDeliveryJob.Status.CANCELED, 0),
        },
    }
