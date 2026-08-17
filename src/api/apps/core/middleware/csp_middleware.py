import logging
import re
import secrets
from urllib.parse import urlsplit

from django.conf import settings

logger = logging.getLogger(__name__)


class ContentSecurityPolicyMiddleware:
    """Add the configured content security policy to application responses."""

    _UNFOLD_THEME_STYLE_PATTERN = re.compile(
        r"<style\b(?P<attrs>[^>]*\bid=[\"']unfold-theme-colors[\"'][^>]*)>",
        flags=re.IGNORECASE,
    )
    _UNFOLD_CHANGELIST_STYLE_PATTERN = re.compile(
        r"<style\b(?P<attrs>[^>]*)>(?=\s*#changelist table thead th:first-child \{width: inherit\})",
        flags=re.IGNORECASE,
    )
    _NONCE_ATTRIBUTE_PATTERN = re.compile(r"\bnonce\s*=", flags=re.IGNORECASE)

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        # Make the nonce available before template rendering. Source-owned
        # templates opt in explicitly; the response rewriter below is limited
        # to two unavoidable styles from the upstream admin theme.
        request.csp_nonce = secrets.token_urlsafe(24)
        response = self.get_response(request)
        if (
            "Content-Security-Policy" in response
            or "Content-Security-Policy-Report-Only" in response
        ):
            return response

        report_only = getattr(settings, "CSP_REPORT_ONLY", True)
        header_name = (
            "Content-Security-Policy-Report-Only" if report_only else "Content-Security-Policy"
        )
        response[header_name] = self._build_policy(
            request.csp_nonce,
            allow_framing=bool(getattr(response, "xframe_options_exempt", False)),
        )
        self._nonce_vendor_styles(response, request.csp_nonce)
        return response

    @staticmethod
    def _configured_sources(setting_name: str, default: tuple[str, ...]) -> list[str]:
        return [
            str(source).strip()
            for source in getattr(settings, setting_name, default)
            if str(source).strip()
        ]

    @staticmethod
    def _url_origin(value: object) -> str | None:
        """Return a CSP origin for an absolute HTTP(S) asset URL."""

        try:
            parsed = urlsplit(str(value or ""))
            hostname = parsed.hostname
            port = parsed.port
        except (TypeError, ValueError):
            return None
        if parsed.scheme not in {"http", "https"} or not hostname:
            return None
        rendered_host = f"[{hostname}]" if ":" in hostname else hostname
        rendered_port = f":{port}" if port is not None else ""
        return f"{parsed.scheme}://{rendered_host}{rendered_port}"

    def _storage_origins(self) -> list[str]:
        origins = []
        for setting_name in ("STATIC_URL", "MEDIA_URL"):
            origin = self._url_origin(getattr(settings, setting_name, ""))
            if origin:
                origins.append(origin)
        return list(dict.fromkeys(origins))

    def _build_policy(
        self,
        nonce: str,
        *,
        allow_framing: bool = False,
    ) -> str:
        storage_origins = self._storage_origins()
        script_sources = self._configured_sources(
            "CSP_SCRIPT_SOURCES",
            ("'self'", "https://cdn.jsdelivr.net"),
        )
        style_sources = self._configured_sources(
            "CSP_STYLE_SOURCES",
            ("'self'", "https://fonts.googleapis.com"),
        )
        font_sources = self._configured_sources(
            "CSP_FONT_SOURCES",
            ("'self'", "data:", "https://fonts.gstatic.com"),
        )
        image_sources = self._configured_sources(
            "CSP_IMAGE_SOURCES",
            ("'self'", "data:", "blob:"),
        )
        connect_sources = self._configured_sources(
            "CSP_CONNECT_SOURCES",
            ("'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"),
        )
        frame_sources = self._configured_sources("CSP_FRAME_SOURCES", ("'self'",))
        frontend_origin = self._url_origin(getattr(settings, "FRONTEND_URL", ""))
        if frontend_origin:
            frame_sources.append(frontend_origin)
            connect_sources.append(frontend_origin)

        nonce_source = f"'nonce-{nonce}'"
        media_sources = list(dict.fromkeys(["'self'", "blob:", *storage_origins]))
        directives = [
            "default-src 'self'",
            f"script-src {' '.join(dict.fromkeys([*script_sources, *storage_origins, nonce_source]))}",
            "script-src-attr 'none'",
            f"style-src {' '.join(dict.fromkeys([*style_sources, *storage_origins, nonce_source]))}",
            # Django Admin, Unfold, CodeMirror, and the vendored QR scanner
            # set presentation-only style attributes. Scope the compatibility
            # exception to attributes; style elements still require a nonce
            # and script handlers remain completely disabled.
            "style-src-attr 'unsafe-inline'",
            f"img-src {' '.join(dict.fromkeys([*image_sources, *storage_origins]))}",
            f"font-src {' '.join(dict.fromkeys([*font_sources, *storage_origins]))}",
            f"frame-src {' '.join(dict.fromkeys(frame_sources))}",
            f"connect-src {' '.join(dict.fromkeys(connect_sources))}",
            f"media-src {' '.join(media_sources)}",
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "report-uri /csp-report/",
        ]
        if not allow_framing:
            directives.insert(-1, "frame-ancestors 'none'")
        return "; ".join(directives)

    def _nonce_vendor_styles(self, response, nonce: str) -> None:
        """Attach the response nonce to inline styles from vendor templates.

        Unfold ships dynamic inline theme styles but does not expose a nonce
        hook. Rewriting style elements keeps those fragments compatible with
        enforcing CSP. Inline scripts are deliberately excluded and must opt
        in from a trusted template. Non-HTML, streaming, and encoded responses
        are left untouched.
        """

        if getattr(response, "streaming", False):
            return
        content_type = response.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type not in {"text/html", "application/xhtml+xml"}:
            return
        if response.get("Content-Encoding", "").lower() not in {"", "identity"}:
            return

        charset = getattr(response, "charset", None) or settings.DEFAULT_CHARSET
        try:
            content = response.content.decode(charset)
        except (AttributeError, LookupError, UnicodeDecodeError):
            logger.exception("Unable to nonce CSP inline elements")
            return

        def _add_nonce(match: re.Match) -> str:
            attrs = match.group("attrs")
            if self._NONCE_ATTRIBUTE_PATTERN.search(attrs):
                return match.group(0)
            return f'<style{attrs} nonce="{nonce}">'

        # Source-owned inline elements opt in from trusted templates with
        # ``nonce="{{ request.csp_nonce }}"``. Automatically blessing every
        # rendered tag would turn otherwise-blocked HTML injection into
        # trusted markup. These two narrowly matched styles are the only
        # unavoidable inline blocks in Unfold's upstream templates.
        rewritten = self._UNFOLD_THEME_STYLE_PATTERN.sub(_add_nonce, content)
        rewritten = self._UNFOLD_CHANGELIST_STYLE_PATTERN.sub(_add_nonce, rewritten)
        if rewritten == content:
            return
        response.content = rewritten.encode(charset)
        if "Content-Length" in response:
            response["Content-Length"] = str(len(response.content))
