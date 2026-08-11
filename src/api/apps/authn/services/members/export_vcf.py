"""
Export members to vCard 3.0 (.vcf) format.

vCard 3.0 (RFC 2426) is hand-rolled here for maximum import compatibility
with Apple Contacts, Google Contacts, and Outlook without adding a new
third-party dependency.
"""

from __future__ import annotations

CRLF = "\r\n"
MAX_LINE_OCTETS = 75
PHOTO_MIME_TYPES = {
    "gif": "GIF",
    "jpeg": "JPEG",
    "jpg": "JPEG",
    "png": "PNG",
    "webp": "WEBP",
}


def export_members_to_vcard(queryset) -> bytes:
    """Return a single .vcf payload covering every member in the queryset."""
    queryset = queryset.only(
        "id",
        "first_name",
        "middle_name",
        "last_name",
        "organization",
        "title",
        "profile_image",
    ).prefetch_related("contact_emails", "contact_phones")

    cards: list[str] = []
    for member in queryset:
        cards.append(_build_vcard(member))

    payload = CRLF.join(cards)
    if payload:
        payload += CRLF
    return payload.encode("utf-8")


def _build_vcard(member) -> str:
    contact_emails = list(member.contact_emails.all())
    primary_email = next((ce for ce in contact_emails if ce.email_type == "primary"), None)
    secondary_email = next((ce for ce in contact_emails if ce.email_type == "secondary"), None)
    phone = next(iter(member.contact_phones.all()), None)

    first = (member.first_name or "").strip()
    middle = (member.middle_name or "").strip()
    last = (member.last_name or "").strip()

    full_name = (member.get_full_name() or "").strip()
    if not full_name:
        full_name = (primary_email.email_address if primary_email else f"Member {str(member.id)[:8]}").strip()

    lines: list[str] = ["BEGIN:VCARD", "VERSION:3.0"]
    lines.append(_fold(f"FN:{_escape(full_name)}"))
    lines.append(_fold(f"N:{_escape(last)};{_escape(first)};{_escape(middle)};;"))

    if member.organization:
        lines.append(_fold(f"ORG:{_escape(member.organization)}"))
    if member.title:
        lines.append(_fold(f"TITLE:{_escape(member.title)}"))

    if primary_email and primary_email.email_address:
        lines.append(_fold(f"EMAIL;TYPE=INTERNET,PREF:{_escape(primary_email.email_address)}"))
    if secondary_email and secondary_email.email_address:
        lines.append(_fold(f"EMAIL;TYPE=INTERNET:{_escape(secondary_email.email_address)}"))

    if phone:
        try:
            tel = phone.to_e164()
        except Exception:
            tel = ""
        if tel:
            lines.append(_fold(f"TEL;TYPE=CELL:{_escape(tel)}"))

    photo_b64, photo_type = _profile_image(member.profile_image)
    if photo_b64:
        photo_params = "PHOTO;ENCODING=b"
        if photo_type:
            photo_params += f";TYPE={photo_type}"
        lines.append(_fold(f"{photo_params}:{photo_b64}"))

    lines.append(f"UID:urn:uuid:{member.id}")
    lines.append("END:VCARD")
    return CRLF.join(lines)


def _escape(value: str) -> str:
    """Escape a text-property value per RFC 2426 §4."""
    if value is None:
        return ""
    return (
        value.replace("\\", "\\\\")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
        .replace("\r", "\\n")
        .replace(",", "\\,")
        .replace(";", "\\;")
    )


def _fold(line: str) -> str:
    """Fold a content line so each physical line is <= 75 octets (RFC 2426 §2.6).

    Continuation lines are prefixed with a single space.
    """
    if len(line.encode("utf-8")) <= MAX_LINE_OCTETS:
        return line

    pieces: list[str] = []
    current: list[str] = []
    current_octets = 0
    limit = MAX_LINE_OCTETS

    for char in line:
        char_octets = len(char.encode("utf-8"))
        if current and current_octets + char_octets > limit:
            pieces.append("".join(current))
            current = [char]
            current_octets = char_octets
            limit = MAX_LINE_OCTETS - 1
        else:
            current.append(char)
            current_octets += char_octets
    if current:
        pieces.append("".join(current))

    folded = pieces[0]
    for piece in pieces[1:]:
        folded += CRLF + " " + piece
    return folded


def _profile_image(value: str | None) -> tuple[str, str]:
    if not value:
        return "", ""
    raw = value.strip()
    if raw.startswith("data:") and "," in raw:
        metadata, payload = raw[5:].split(",", 1)
        mime_type = metadata.split(";", 1)[0].lower()
        subtype = mime_type.split("/", 1)[1] if mime_type.startswith("image/") and "/" in mime_type else ""
        return payload.strip(), PHOTO_MIME_TYPES.get(subtype, "")
    return raw, ""
