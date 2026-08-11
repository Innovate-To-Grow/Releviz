"""Per-Django-app admin access predicate.

The project replaced per-user Django ``user_permissions`` with coarse per-app access:
an admin member carries a list of app labels (``Member.admin_apps``) and may
view/add/change/delete every model in any app on that list. ``is_superuser`` (the
I2G Master account) bypasses the list entirely.

This helper is the single source of truth for that decision and is enforced at every
gate (the Django admin base class, the shared ``safe_orm`` layer / AI action engine,
and the ``/admin-api/`` CLI). It deliberately *duck-types* the user object — it only
reads attributes and never imports ``Member`` — so ``apps.core`` keeps no import
dependency on ``apps.authn``.
"""


def user_can_access_app(user, app_label: str) -> bool:
    """Return whether ``user`` may manage records in the Django app ``app_label``.

    Access requires an authenticated, active staff member. Superusers (I2G Master)
    are always granted. Everyone else is granted only for the apps listed in their
    ``admin_apps``.
    """
    if not (
        user
        and getattr(user, "is_authenticated", False)
        and getattr(user, "is_active", False)
        and getattr(user, "is_staff", False)
    ):
        return False
    if getattr(user, "is_superuser", False):
        return True
    return app_label in (getattr(user, "admin_apps", None) or [])
