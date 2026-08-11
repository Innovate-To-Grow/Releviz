from django.db.models import Q

from .helpers import _serialize_rows


def search_projects(params):
    from apps.projects.models import Project

    qs = Project.objects.all()
    if params.get("title"):
        qs = qs.filter(project_title__icontains=params["title"])
    if params.get("team_name"):
        qs = qs.filter(team_name__icontains=params["team_name"])
    if params.get("organization"):
        qs = qs.filter(organization__icontains=params["organization"])
    if params.get("industry"):
        qs = qs.filter(industry__icontains=params["industry"])
    if params.get("semester"):
        qs = qs.filter(
            Q(semester__label__icontains=params["semester"]) | Q(semester__season__icontains=params["semester"])
        )
    if params.get("class_code"):
        qs = qs.filter(class_code__icontains=params["class_code"])
    qs = qs.select_related("semester").order_by("-semester__year", "team_number")
    return _serialize_rows(
        qs,
        [
            "id",
            "project_title",
            "team_name",
            "team_number",
            "class_code",
            "organization",
            "industry",
            "student_names",
            "semester__label",
        ],
    )


def search_semesters(params):
    from apps.projects.models import Semester

    qs = Semester.objects.all()
    if params.get("year"):
        qs = qs.filter(year=params["year"])
    if params.get("season"):
        qs = qs.filter(season__icontains=params["season"])
    if params.get("is_published") is not None:
        qs = qs.filter(is_published=params["is_published"])
    return _serialize_rows(qs.order_by("-year", "season"), ["id", "year", "season", "label", "is_published"])
