"""Shared access rule for the single administrator role."""


def user_can_access_app(user, app_label: str) -> bool:
    """Allow active administrators into every app.

    ``app_label`` remains for existing callers; legacy app grants do not restrict
    administrators. Individual model admins still enforce read-only safeguards.
    """
    return bool(
        user
        and getattr(user, "is_authenticated", False)
        and getattr(user, "is_active", False)
        and getattr(user, "is_staff", False)
    )
