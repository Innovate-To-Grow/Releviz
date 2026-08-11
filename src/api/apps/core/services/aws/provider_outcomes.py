from botocore.config import Config
from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    ConnectionClosedError,
    ConnectTimeoutError,
    EndpointConnectionError,
    ParamValidationError,
    ReadTimeoutError,
)

PROVIDER_OUTCOME_SUCCESS = "success"
PROVIDER_OUTCOME_TRANSIENT = "transient"
PROVIDER_OUTCOME_PERMANENT = "permanent"
PROVIDER_OUTCOME_UNCERTAIN = "uncertain"

NO_PROVIDER_RETRIES = Config(
    retries={"total_max_attempts": 1, "mode": "standard"},
)

_TRANSIENT_ERROR_CODES = {
    "InternalFailure",
    "InternalServerException",
    "InternalServiceError",
    "LimitExceededException",
    "RequestTimeout",
    "ServiceQuotaExceededException",
    "ServiceUnavailable",
    "Throttling",
    "ThrottlingException",
    "TooManyRequestsException",
}


class ProviderDeliveryError(RuntimeError):
    """Sanitized provider failure with a retry-safety classification."""

    def __init__(self, message: str, *, outcome: str):
        super().__init__(message)
        self.outcome = outcome


def classify_aws_send_failure(exc: Exception, *, provider: str) -> tuple[str, str]:
    """Classify one AWS send failure without leaking provider details."""
    if isinstance(exc, ClientError):
        response = exc.response or {}
        code = str(response.get("Error", {}).get("Code") or "")
        http_status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in _TRANSIENT_ERROR_CODES or (
            isinstance(http_status, int) and (http_status in {408, 429} or http_status >= 500)
        ):
            return (
                PROVIDER_OUTCOME_TRANSIENT,
                f"{provider} temporarily rejected the request.",
            )
        return PROVIDER_OUTCOME_PERMANENT, f"{provider} rejected the request."
    if isinstance(exc, EndpointConnectionError | ConnectTimeoutError):
        return (
            PROVIDER_OUTCOME_TRANSIENT,
            f"{provider} could not be reached before request acceptance.",
        )
    if isinstance(exc, ParamValidationError):
        return PROVIDER_OUTCOME_PERMANENT, f"{provider} request validation failed."
    if isinstance(exc, ReadTimeoutError | ConnectionClosedError):
        return (
            PROVIDER_OUTCOME_UNCERTAIN,
            f"{provider} response was lost after the request began.",
        )
    if isinstance(exc, BotoCoreError):
        return (
            PROVIDER_OUTCOME_UNCERTAIN,
            f"{provider} request outcome could not be confirmed.",
        )
    return (
        PROVIDER_OUTCOME_UNCERTAIN,
        f"{provider} request outcome could not be confirmed.",
    )
