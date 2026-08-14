from .common import prop, tool_spec

DEFINITIONS = [
    tool_spec(
        "run_custom_query",
        "Run a flexible database query against any allowed model. Available models: Member, ContactEmail, Event, EventRegistration, Ticket, CheckIn, CheckInRecord, Project, Semester, EmailCampaign, RecipientLog, CMSPage, CMSBlock, NewsArticle, NewsFeedSource, PageView, Menu. Filters use Django ORM lookup syntax (e.g. name__icontains, date__gte).",
        {
            "model": prop("string", "Model name (e.g. Member, Event)"),
            "filters": prop(
                "object",
                "Django ORM filter kwargs (e.g. {name__icontains: demo, registration_open: true})",
            ),
            "ordering": {
                "description": "Field(s) to order by (string or array of strings, prefix with - for desc)"
            },
            "fields": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Specific fields to return (if omitted, returns all fields)",
            },
            "count_only": prop("boolean", "If true, only return the count"),
            "limit": prop("integer", "Max rows to return (default 50, max 50)"),
        },
        required=["model"],
    ),
]
