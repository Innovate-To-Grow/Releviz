from .common import prop, tool_spec

DEFINITIONS = [
    tool_spec(
        "search_cms_pages",
        "Search CMS pages by title, slug, or status (draft/published/archived).",
        {
            "title": prop("string", "Search by page title (partial match)"),
            "slug": prop("string", "Search by page slug (partial match)"),
            "status": prop("string", "Filter by status: draft, published, or archived"),
        },
    ),
    tool_spec(
        "search_news",
        "Search news articles by title, source, or date range.",
        {
            "title": prop("string", "Search by article title (partial match)"),
            "source": prop("string", "Filter by news source (partial match)"),
            "date_from": prop("string", "Start date (YYYY-MM-DD)"),
            "date_to": prop("string", "End date (YYYY-MM-DD)"),
        },
    ),
    tool_spec(
        "get_page_views",
        "Get website analytics page views, optionally filtered by path or date range. Returns view counts by date and top pages.",
        {
            "path": prop("string", "Filter by URL path (partial match)"),
            "date_from": prop("string", "Start date (YYYY-MM-DD)"),
            "date_to": prop("string", "End date (YYYY-MM-DD)"),
            "count_only": prop("boolean", "If true, only return the total count"),
        },
    ),
]
