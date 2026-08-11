from .common import prop, tool_spec

DEFINITIONS = [
    tool_spec(
        "search_projects",
        "Search student projects by title, team name, organization, industry, semester, or class code.",
        {
            "title": prop("string", "Search by project title (partial match)"),
            "team_name": prop("string", "Search by team name (partial match)"),
            "organization": prop("string", "Filter by organization (partial match)"),
            "industry": prop("string", "Filter by industry (partial match)"),
            "semester": prop("string", "Filter by semester label or season (e.g. Spring 2025, Fall)"),
            "class_code": prop("string", "Filter by class code (partial match)"),
        },
    ),
    tool_spec(
        "search_semesters",
        "Search academic semesters by year, season, or published status.",
        {
            "year": prop("integer", "Filter by year"),
            "season": prop("string", "Filter by season (Spring/Fall)"),
            "is_published": prop("boolean", "Filter by published status"),
        },
    ),
]
