import hashlib
import json
import logging
import re
from urllib.parse import urlsplit

from django.conf import settings
from django.core.cache import cache
from django.http import HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

logger = logging.getLogger(__name__)

_SENSITIVE_CSP_PATH_SEGMENT = re.compile(
    r"(?P<prefix>/(?:invite|preview|resubscribe|unsubscribe)/)[^/]+",
    flags=re.IGNORECASE,
)


def _csp_report_rate_limited(request) -> bool:
    """Return whether this client exceeded the bounded CSP report window."""

    limit = max(int(getattr(settings, "CSP_REPORT_RATE_LIMIT", 60)), 1)
    window = max(int(getattr(settings, "CSP_REPORT_RATE_WINDOW_SECONDS", 60)), 1)
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if getattr(settings, "NUM_PROXIES", None) and forwarded_for:
        parts = [part.strip() for part in forwarded_for.split(",") if part.strip()]
        ident = parts[-1] if parts else request.META.get("REMOTE_ADDR", "unknown")
    else:
        ident = request.META.get("REMOTE_ADDR", "unknown")
    digest = hashlib.sha256(str(ident).encode("utf-8", errors="replace")).hexdigest()
    key = f"csp-report-rate:{digest}"
    try:
        if cache.add(key, 1, timeout=window):
            return False
        return cache.incr(key) > limit
    except Exception:
        # Reporting is diagnostic. A cache outage must not affect application
        # traffic, and downstream log-volume controls remain in place.
        logger.exception("Unable to apply CSP report rate limit")
        return False


# Browser CSP reports are unauthenticated diagnostics and cannot mutate user
# state. Requiring Django's CSRF cookie would make the reporting endpoint unusable.
# nosemgrep: python.django.security.audit.csrf-exempt.no-csrf-exempt
@require_POST
@csrf_exempt
def csp_report(request):
    """Log CSP violation reports posted by the browser.

    Browsers POST a JSON report to this endpoint when a CSP rule is violated.
    We log at WARNING level so ops can observe violation patterns in CloudWatch
    before promoting the header from report-only to enforcing.

    The endpoint is publicly reachable, so the body is attacker-controlled.
    We parse it as JSON and log only the specific fields we care about — this
    prevents log-injection (forged newlines, ANSI escapes) and drops the raw
    bytes on the floor if the payload isn't a real report.
    """
    try:
        if _csp_report_rate_limited(request):
            return HttpResponse(status=204)

        try:
            content_length = int(request.META.get("CONTENT_LENGTH") or 0)
        except (TypeError, ValueError):
            content_length = 0
        if content_length > 4096:
            return HttpResponse(status=413)

        raw = request.body[:4096]
        try:
            payload = json.loads(raw.decode("utf-8", errors="replace"))
        except (ValueError, UnicodeDecodeError):
            logger.warning("CSP report with unparseable body (%d bytes)", len(raw))
            return HttpResponse(status=204)

        report = payload.get("csp-report") if isinstance(payload, dict) else None
        if not isinstance(report, dict):
            logger.warning("CSP report missing 'csp-report' object")
            return HttpResponse(status=204)

        def _clean(value: object) -> str:
            # Drop control chars (including newlines) so an attacker can't
            # forge extra log lines. 256-char cap per field keeps log volume
            # bounded even under spray. Two-step strip: explicit `\r` / `\n`
            # removal is the pattern CodeQL recognizes as a log-injection
            # sanitizer; the printable-char filter follows to also catch
            # ANSI escapes and other control bytes.
            s = str(value) if value is not None else ""
            s = s.replace("\r", " ").replace("\n", " ")
            s = "".join(ch for ch in s if ch.isprintable())
            try:
                parsed = urlsplit(s)
                if parsed.scheme in {"http", "https"} and parsed.hostname:
                    # Reports can include signed or callback URLs. Keep the
                    # route useful for diagnostics but never log credentials,
                    # query parameters, or fragments.
                    host = parsed.hostname
                    if ":" in host:
                        host = f"[{host}]"
                    try:
                        parsed_port = parsed.port
                    except ValueError:
                        parsed_port = None
                    port = f":{parsed_port}" if parsed_port is not None else ""
                    path = _SENSITIVE_CSP_PATH_SEGMENT.sub(
                        r"\g<prefix><redacted>",
                        parsed.path,
                    )
                    s = f"{parsed.scheme}://{host}{port}{path}"
            except (TypeError, ValueError):
                pass
            return s[:256]

        directive = _clean(report.get("violated-directive") or report.get("effective-directive"))
        blocked = _clean(report.get("blocked-uri"))
        document = _clean(report.get("document-uri"))
        source = _clean(report.get("source-file"))
        logger.warning(
            "CSP violation: directive=%s blocked=%s document=%s source=%s",
            directive,
            blocked,
            document,
            source,
        )
    except Exception:
        logger.exception("Unexpected error processing CSP violation report")
    return HttpResponse(status=204)
