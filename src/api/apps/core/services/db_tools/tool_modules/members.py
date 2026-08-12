from django.db.models import Q

from .helpers import _serialize_rows


def search_members(params):
    from apps.authn.models import Member

    qs = Member.objects.all()
    if params.get("name"):
        for term in params["name"].split():
            qs = qs.filter(Q(first_name__icontains=term) | Q(last_name__icontains=term))
    if params.get("email"):
        qs = qs.filter(contact_emails__email_address__icontains=params["email"])
    if params.get("is_staff") is not None:
        qs = qs.filter(is_staff=params["is_staff"])
    if params.get("is_active") is not None:
        qs = qs.filter(is_active=params["is_active"])
    return _serialize_rows(
        qs.distinct(),
        [
            "id",
            "first_name",
            "last_name",
            "is_staff",
            "is_active",
            "created_at",
        ],
    )


def count_members(params):
    from apps.authn.models import Member

    qs = Member.objects.all()
    if params.get("is_staff") is not None:
        qs = qs.filter(is_staff=params["is_staff"])
    if params.get("is_active") is not None:
        qs = qs.filter(is_active=params["is_active"])
    return f"Count: {qs.count()}"
