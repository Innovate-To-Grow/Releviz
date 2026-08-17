"""Errors raised while finalizing an event."""


class FinalizationError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code
