# Re-exported from the shared util so existing imports of these names keep
# working while the neutralization logic lives in one place.
from apps.core.services.helpers.sheets_safety import FORMULA_TRIGGERS, safe_sheet_value

__all__ = ["FORMULA_TRIGGERS", "safe_sheet_value", "build_header", "build_row"]


def build_header() -> list[str]:
    return [
        "UUID",
        "First Name",
        "Middle Name",
        "Last Name",
        "Primary Email",
        "Primary Phone",
        "Organization",
        "Title",
        "Date Joined (UTC)",
        "Last Updated (UTC)",
        "Active",
    ]


def build_row(member) -> list[str]:
    phones = getattr(member, "_prefetched_objects_cache", {}).get("contact_phones")
    if phones is not None:
        primary_phone = phones[0].phone_number if phones else ""
    else:
        phone_obj = member.contact_phones.first()
        primary_phone = phone_obj.phone_number if phone_obj else ""

    return [
        str(member.id),
        safe_sheet_value(member.first_name),
        safe_sheet_value(member.middle_name),
        safe_sheet_value(member.last_name),
        safe_sheet_value(member.get_primary_email()),
        safe_sheet_value(primary_phone),
        safe_sheet_value(member.organization),
        safe_sheet_value(member.title),
        member.date_joined.strftime("%Y-%m-%d %H:%M"),
        member.updated_at.strftime("%Y-%m-%d %H:%M"),
        "Yes" if member.is_active else "No",
    ]
