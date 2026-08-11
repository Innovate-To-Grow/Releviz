import re

SENSITIVE_FIELD_RE = re.compile(
    r"(password|secret|token|api[_-]?key|private|credential|session|hash|salt)",
    re.IGNORECASE,
)
DENIED_FIELD_NAMES = {
    "is_staff",
    "is_superuser",
    "groups",
    "user_permissions",
    "permissions",
    "bypass_password",
}
DENIED_READ_APP_LABELS = {"admin", "contenttypes", "sessions"}
DENIED_WRITE_APP_LABELS = DENIED_READ_APP_LABELS | {"auth"}
DENIED_MODEL_LABELS = {
    "auth.group",
    "auth.permission",
    "core.awscredentialconfig",
    "core.emailserviceconfig",
    "core.gmailaccessaccount",
    "core.googlecredentialconfig",
    "system_intelligence.chatconversation",
    "system_intelligence.chatmessage",
    "system_intelligence.systemintelligenceactionrequest",
    "system_intelligence.systemintelligenceconfig",
    "cms.cmsblock",
    "cms.cmspage",
}
DENIED_MODEL_NAME_PARTS = ("credential", "config", "permission", "session", "logentry", "token")
SAFE_LOOKUPS = frozenset(
    {
        "exact",
        "iexact",
        "contains",
        "icontains",
        "in",
        "gt",
        "gte",
        "lt",
        "lte",
        "startswith",
        "istartswith",
        "endswith",
        "iendswith",
        "range",
        "date",
        "year",
        "month",
        "day",
        "isnull",
    }
)

__all__ = [
    "DENIED_FIELD_NAMES",
    "DENIED_MODEL_LABELS",
    "DENIED_MODEL_NAME_PARTS",
    "DENIED_READ_APP_LABELS",
    "DENIED_WRITE_APP_LABELS",
    "SAFE_LOOKUPS",
    "SENSITIVE_FIELD_RE",
]
