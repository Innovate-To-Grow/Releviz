"""Errors raised while importing a roster."""


class RosterImportError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400, extra: dict | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.extra = extra or {}
