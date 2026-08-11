import json

from django.db.models import Count, Q

from .helpers import _serialize_rows, _truncate


def search_events(params):
    from apps.event.models import Event

    qs = Event.objects.all()
    if params.get("name"):
        qs = qs.filter(name__icontains=params["name"])
    if params.get("registration_open") is not None:
        qs = qs.filter(registration_open=params["registration_open"])
    if params.get("date_from"):
        qs = qs.filter(Q(end_date__gte=params["date_from"]) | Q(end_date__isnull=True, date__gte=params["date_from"]))
    if params.get("date_to"):
        qs = qs.filter(date__lte=params["date_to"])
    return _serialize_rows(
        qs.order_by("-date"),
        ["id", "name", "slug", "date", "end_date", "location", "registration_open"],
        fallback_fields={"end_date": "date"},
    )


def get_event_registrations(params):
    from apps.event.models import EventRegistration

    qs = EventRegistration.objects.all()
    if params.get("event_name"):
        qs = qs.filter(event__name__icontains=params["event_name"])
    if params.get("event_id"):
        qs = qs.filter(event_id=params["event_id"])
    if params.get("count_only"):
        return f"Registration count: {qs.count()}"
    return _serialize_rows(
        qs,
        [
            "id",
            "attendee_first_name",
            "attendee_last_name",
            "attendee_email",
            "attendee_organization",
            "event__name",
            "ticket__name",
            "created_at",
        ],
    )


def get_checkin_stats(params):
    from apps.event.models import CheckInRecord

    qs = CheckInRecord.objects.all()
    if params.get("event_name"):
        qs = qs.filter(check_in__event__name__icontains=params["event_name"])
    if params.get("event_id"):
        qs = qs.filter(check_in__event_id=params["event_id"])
    grouped = qs.values("check_in__name", "check_in__event__name").annotate(count=Count("id")).order_by("-count")
    return _truncate(f"Total check-ins: {qs.count()}\nBy station:\n{json.dumps(list(grouped), default=str)}")
