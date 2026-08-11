"""Small security helpers shared across backend integrations."""

from __future__ import annotations

from urllib.parse import urlparse, urlunparse


class SecurityValidationError(ValueError):
    """Raised when untrusted input fails a security boundary check."""


def _is_safe_dns_label(label: str) -> bool:
    if not label or len(label) > 63 or label.startswith("-") or label.endswith("-"):
        return False
    return all(char.isascii() and (char.isalnum() or char == "-") for char in label)


def _is_allowed_sns_host(host: str) -> bool:
    for suffix in (".amazonaws.com", ".amazonaws.com.cn"):
        if host == f"sns{suffix}":
            return True
        if not host.endswith(suffix):
            continue
        labels = host[: -len(suffix)].split(".")
        return labels[0] == "sns" and all(_is_safe_dns_label(label) for label in labels[1:])
    return False


def validate_aws_sns_https_url(url: str) -> str:
    """Return *url* only when it is an HTTPS URL hosted by AWS SNS."""
    parsed = urlparse(str(url or ""))
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https":
        raise SecurityValidationError("SNS URL must be https")
    if parsed.username or parsed.password:
        raise SecurityValidationError("SNS URL must not include credentials")
    if parsed.port not in (None, 443):
        raise SecurityValidationError("SNS URL must use the default HTTPS port")
    if not _is_allowed_sns_host(host):
        raise SecurityValidationError("SNS URL host is not allowed")
    return urlunparse(("https", parsed.netloc, parsed.path, parsed.params, parsed.query, ""))
