from .common import prop, tool_spec

DEFINITIONS = [
    tool_spec(
        "search_members",
        "Search members (users) in the database by name, email, organization, or staff/active status. Returns up to 50 matching members.",
        {
            "name": prop("string", "Search by first or last name (partial match)"),
            "email": prop("string", "Search by email address (partial match)"),
            "organization": prop("string", "Filter by organization (partial match)"),
            "is_staff": prop("boolean", "Filter by staff status"),
            "is_active": prop("boolean", "Filter by active status"),
        },
    ),
    tool_spec(
        "count_members",
        "Count members in the database with optional filters.",
        {
            "is_staff": prop("boolean", "Filter by staff status"),
            "is_active": prop("boolean", "Filter by active status"),
            "organization": prop("string", "Filter by organization (partial match)"),
        },
    ),
]
