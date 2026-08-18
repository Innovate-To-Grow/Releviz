"""Errors raised by event write operations."""


class EventManagementError(ValueError):
    def __init__(self, message, *, status_code=400, event=None, extra=None):
        super().__init__(message)
        self.status_code = status_code
        self.event = event
        self.extra = extra or {}
