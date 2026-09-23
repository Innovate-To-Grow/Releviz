"""Errors raised while managing invitations and managed participants."""

INACTIVE_ACCOUNT_MESSAGE = "This email belongs to an inactive account."
UNVERIFIED_FULL_ACCOUNT_MESSAGE = "This email belongs to an unverified full account."
SHARED_ACCOUNT_MESSAGE = "Another selected row already uses this person's account."


class EventEmailRequestError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class ManagedParticipantError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400, error_code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code
