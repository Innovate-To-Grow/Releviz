import json

from django.db.models import Count

from .helpers import _serialize_rows


def search_email_campaigns(params):
    from apps.mail.models import EmailCampaign

    qs = EmailCampaign.objects.all()
    if params.get("name"):
        qs = qs.filter(name__icontains=params["name"])
    if params.get("status"):
        qs = qs.filter(status=params["status"])
    if params.get("subject"):
        qs = qs.filter(subject__icontains=params["subject"])
    return _serialize_rows(
        qs.order_by("-created_at"),
        [
            "id",
            "name",
            "subject",
            "status",
            "audience_type",
            "total_recipients",
            "sent_count",
            "failed_count",
            "sent_at",
            "created_at",
        ],
    )


def get_campaign_stats(params):
    from apps.mail.models import EmailCampaign, RecipientLog

    qs = EmailCampaign.objects.all()
    if params.get("campaign_name"):
        qs = qs.filter(name__icontains=params["campaign_name"])
    if params.get("campaign_id"):
        qs = qs.filter(id=params["campaign_id"])
    campaign = qs.first()
    if not campaign:
        return "No campaign found matching the criteria."
    stats = RecipientLog.objects.filter(campaign=campaign).values("status").annotate(count=Count("id"))
    return (
        f"Campaign: {campaign.name}\nSubject: {campaign.subject}\nStatus: {campaign.status}\n"
        f"Total recipients: {campaign.total_recipients}\n"
        f"Sent: {campaign.sent_count}, Failed: {campaign.failed_count}\n"
        f"Delivery breakdown: {json.dumps(list(stats), default=str)}"
    )
