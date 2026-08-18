import logging

from django.conf import settings
from django.db.models import Count, Min, Q
from django.utils import timezone

from apps.core.models import BackgroundJob

logger = logging.getLogger(__name__)


def worker_metrics() -> dict[str, float | int]:
    from apps.mail.models import EmailDeliveryJob

    now = timezone.now()
    aggregates = BackgroundJob.objects.aggregate(
        oldest=Min(
            "created_at",
            filter=Q(status__in=[BackgroundJob.Status.PENDING, BackgroundJob.Status.RETRY]),
        )
    )
    counts = {
        row["status"]: row["count"]
        for row in BackgroundJob.objects.values("status").annotate(count=Count("id"))
    }
    oldest = aggregates["oldest"]
    return {
        "heartbeat": 1,
        "queue_depth": counts.get(BackgroundJob.Status.PENDING, 0)
        + counts.get(BackgroundJob.Status.RETRY, 0),
        "oldest_job_age_seconds": max(0, (now - oldest).total_seconds()) if oldest else 0,
        "failed_jobs": counts.get(BackgroundJob.Status.FAILED, 0),
        "uncertain_jobs": counts.get(BackgroundJob.Status.UNCERTAIN, 0),
        "uncertain_email_jobs": EmailDeliveryJob.objects.filter(
            status=EmailDeliveryJob.Status.UNCERTAIN
        ).count(),
    }


def publish_worker_metrics(metrics: dict[str, float | int]) -> None:
    """Publish operational metrics when a CloudWatch namespace is configured."""
    namespace = getattr(settings, "BACKGROUND_JOB_METRICS_NAMESPACE", "")
    if not namespace:
        return
    metric_names = {
        "heartbeat": ("WorkerHeartbeat", "Count"),
        "queue_depth": ("QueueDepth", "Count"),
        "oldest_job_age_seconds": ("OldestJobAge", "Seconds"),
        "failed_jobs": ("FailedJobs", "Count"),
        "uncertain_jobs": ("UncertainJobs", "Count"),
        "uncertain_email_jobs": ("UncertainEmailJobs", "Count"),
    }
    try:
        import boto3

        client = boto3.client(
            "cloudwatch",
            region_name=getattr(settings, "AWS_S3_REGION_NAME", None),
        )
        client.put_metric_data(
            Namespace=namespace,
            MetricData=[
                {
                    "MetricName": metric_name,
                    "Value": float(metrics[key]),
                    "Unit": unit,
                }
                for key, (metric_name, unit) in metric_names.items()
            ],
        )
    except Exception:  # noqa: BLE001 - metrics failure must not stop delivery.
        logger.exception("Could not publish background worker metrics")
