def user_can_access_app(user, app_label: str) -> bool:
    if not getattr(user, "is_authenticated", False):
        return False
    if getattr(user, "is_superuser", False):
        return True
    allowed = getattr(user, "admin_apps", None) or []
    return app_label in allowed
