from .common import prop, tool_spec

DEFINITIONS = [
    tool_spec(
        "search_email_campaigns",
        "Search email campaigns by name, subject, or status (draft/sending/sent/failed).",
        {
            "name": prop("string", "Search by campaign name (partial match)"),
            "subject": prop("string", "Search by email subject (partial match)"),
            "status": prop("string", "Filter by status: draft, sending, sent, or failed"),
        },
    ),
    tool_spec(
        "get_campaign_stats",
        "Get detailed delivery statistics for a specific email campaign.",
        {
            "campaign_name": prop("string", "Campaign name (partial match)"),
            "campaign_id": prop("string", "Exact campaign UUID"),
        },
    ),
]
