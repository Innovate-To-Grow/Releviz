"""Tests for ContentSecurityPolicyMiddleware."""

import json
import re
from unittest.mock import patch

from django.conf import settings
from django.core.cache import cache
from django.http import HttpResponse
from django.test import Client, RequestFactory, TestCase, override_settings

from apps.core.middleware import ContentSecurityPolicyMiddleware, csp_report


class CSPHeaderTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        cache.clear()

        def _view(_request):
            from django.http import HttpResponse

            return HttpResponse("ok")

        self.middleware = ContentSecurityPolicyMiddleware(_view)

    def _header(self):
        request = self.factory.get("/")
        response = self.middleware(request)
        return response, response.get("Content-Security-Policy-Report-Only", "")

    def test_adds_report_only_header(self):
        response, header = self._header()
        self.assertIn("Content-Security-Policy-Report-Only", response)
        self.assertNotIn("Content-Security-Policy", response)
        self.assertTrue(header, "Report-only header must be non-empty")

    @override_settings(FRONTEND_URL="")
    def test_frame_src_defaults_to_same_origin(self):
        _, header = self._header()
        directives = {
            part.strip().split(" ", 1)[0]: part.strip()
            for part in header.split(";")
            if part.strip()
        }

        self.assertEqual(directives["frame-src"], "frame-src 'self'")

    def test_reports_violations_to_local_endpoint(self):
        _, header = self._header()
        self.assertIn("report-uri /csp-report/", header)

    def test_script_src_allows_admin_material_web_dependencies(self):
        _, header = self._header()
        self.assertIn("script-src 'self'", header)
        self.assertIn("https://cdn.jsdelivr.net", header)
        self.assertNotIn("https://esm.run", header)

    @override_settings(
        STATIC_URL="https://static.example.test/static/",
        MEDIA_URL="https://media.example.test/media/",
        FRONTEND_URL="https://frontend.example.test/app/",
        CSP_FRAME_SOURCES=("'self'", "https://video.example.test"),
        CSP_STYLE_SOURCES=("'self'", "https://fonts.googleapis.com"),
        CSP_FONT_SOURCES=("'self'", "data:", "https://fonts.gstatic.com"),
        CSP_CONNECT_SOURCES=(
            "'self'",
            "https://fonts.googleapis.com",
            "https://fonts.gstatic.com",
        ),
    )
    def test_allows_exact_storage_and_font_origins(self):
        _, header = self._header()

        self.assertIn("https://static.example.test", header)
        self.assertIn("https://media.example.test", header)
        self.assertIn("style-src 'self' https://fonts.googleapis.com", header)
        self.assertIn("font-src 'self' data: https://fonts.gstatic.com", header)
        self.assertIn(
            "frame-src 'self' https://video.example.test https://frontend.example.test",
            header,
        )
        self.assertIn(
            "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com https://frontend.example.test",
            header,
        )
        self.assertNotIn("img-src 'self' data: https:", header)

    @override_settings(
        STATIC_URL="https://user:secret@static.example.test:8443/static/",
        MEDIA_URL="/media/",
    )
    def test_asset_origins_never_expose_url_credentials(self):
        _, header = self._header()

        self.assertIn("https://static.example.test:8443", header)
        self.assertNotIn("user", header)
        self.assertNotIn("secret", header)

    def test_disables_inline_script_handlers_without_broad_script_exception(self):
        _, header = self._header()
        directives = {
            part.strip().split(" ", 1)[0]: part.strip()
            for part in header.split(";")
            if part.strip()
        }

        self.assertEqual(directives["script-src-attr"], "script-src-attr 'none'")
        self.assertNotIn("'unsafe-inline'", directives["script-src"])
        self.assertNotIn("'unsafe-eval'", directives["script-src"])
        self.assertNotIn("'unsafe-inline'", directives["style-src"])
        # This intentionally narrow compatibility rule supports style=""
        # attributes emitted by Django Admin/Unfold and vendored widgets.
        self.assertEqual(directives["style-src-attr"], "style-src-attr 'unsafe-inline'")

    def test_nonces_only_trusted_vendor_styles_without_blessing_injected_markup(self):
        def _html_view(_request):
            return HttpResponse(
                '<html><head><style id="unfold-theme-colors">:root{--ok:green}</style>'
                "<style>.injected{color:red}</style></head>"
                "<body><script>window.injected=true</script></body></html>"
            )

        response = ContentSecurityPolicyMiddleware(_html_view)(self.factory.get("/admin/"))
        header = response["Content-Security-Policy-Report-Only"]
        match = re.search(r"'nonce-([^']+)'", header)
        self.assertIsNotNone(match)
        nonce = match.group(1)
        html = response.content.decode()

        self.assertEqual(html.count(f'nonce="{nonce}"'), 1)
        self.assertIn(f'<style id="unfold-theme-colors" nonce="{nonce}">', html)
        self.assertIn("<style>.injected{color:red}</style>", html)
        self.assertIn("<script>window.injected=true</script>", html)

    def test_preserves_explicit_style_nonce(self):
        def _html_view(_request):
            return HttpResponse(
                '<style id="unfold-theme-colors" nonce="template-nonce">.ok{display:block}</style>'
            )

        response = ContentSecurityPolicyMiddleware(_html_view)(self.factory.get("/"))

        self.assertIn('nonce="template-nonce"', response.content.decode())
        self.assertEqual(response.content.decode().count("nonce="), 1)

    def test_vendor_style_rewrite_updates_content_length(self):
        def _html_view(_request):
            response = HttpResponse('<style id="unfold-theme-colors">.ok{display:block}</style>')
            response["Content-Length"] = str(len(response.content))
            return response

        response = ContentSecurityPolicyMiddleware(_html_view)(self.factory.get("/"))

        self.assertIn("nonce=", response.content.decode())
        self.assertEqual(int(response["Content-Length"]), len(response.content))

    def test_nonces_unfold_changelist_compatibility_style(self):
        def _html_view(_request):
            return HttpResponse(
                "<style>\n  #changelist table thead th:first-child {width: inherit}\n</style>"
            )

        response = ContentSecurityPolicyMiddleware(_html_view)(self.factory.get("/admin/example/"))
        nonce = re.search(
            r"'nonce-([^']+)'",
            response["Content-Security-Policy-Report-Only"],
        ).group(1)

        self.assertIn(f'<style nonce="{nonce}">', response.content.decode())

    def test_nonce_is_unique_per_response(self):
        _, first_header = self._header()
        _, second_header = self._header()
        first_nonce = re.search(r"'nonce-([^']+)'", first_header)
        second_nonce = re.search(r"'nonce-([^']+)'", second_header)

        self.assertIsNotNone(first_nonce)
        self.assertIsNotNone(second_nonce)
        self.assertNotEqual(first_nonce.group(1), second_nonce.group(1))

    def test_does_not_rewrite_non_html_responses(self):
        def _json_view(_request):
            return HttpResponse(
                '{"script":"<script>bad()</script>"}', content_type="application/json"
            )

        response = ContentSecurityPolicyMiddleware(_json_view)(self.factory.get("/api/"))

        self.assertNotIn("nonce=", response.content.decode())

    def test_preserves_explicit_frame_exemption(self):
        def _embeddable_view(_request):
            response = HttpResponse("embeddable")
            response.xframe_options_exempt = True
            return response

        response = ContentSecurityPolicyMiddleware(_embeddable_view)(
            self.factory.get("/cms/embed/example/")
        )

        self.assertNotIn("frame-ancestors", response["Content-Security-Policy-Report-Only"])

    def test_does_not_overwrite_existing_enforcing_header(self):
        def _view_with_enforcing(_request):
            from django.http import HttpResponse

            response = HttpResponse("ok")
            response["Content-Security-Policy"] = "default-src 'none'"
            return response

        mw = ContentSecurityPolicyMiddleware(_view_with_enforcing)
        response = mw(self.factory.get("/"))
        self.assertEqual(response["Content-Security-Policy"], "default-src 'none'")
        self.assertNotIn("Content-Security-Policy-Report-Only", response)

    @override_settings(CSP_REPORT_ONLY=False)
    def test_can_promote_to_enforcing_header(self):
        response, _ = self._header()

        self.assertIn("Content-Security-Policy", response)
        self.assertNotIn("Content-Security-Policy-Report-Only", response)

    @override_settings(
        CSP_REPORT_ONLY=False,
        MIDDLEWARE=[*settings.MIDDLEWARE, "apps.core.middleware.ContentSecurityPolicyMiddleware"],
    )
    def test_enforcing_policy_renders_admin_login_with_nonces(self):
        response = Client().get("/admin/login/")

        self.assertEqual(response.status_code, 200)
        header = response["Content-Security-Policy"]
        nonce_match = re.search(r"'nonce-([^']+)'", header)
        self.assertIsNotNone(nonce_match)
        nonce = nonce_match.group(1)
        html = response.content.decode()
        inline_scripts = [
            tag
            for tag in re.findall(r"<script\b[^>]*>", html, flags=re.IGNORECASE)
            if not re.search(r"\bsrc\s*=", tag, flags=re.IGNORECASE)
        ]
        style_elements = re.findall(r"<style\b[^>]*>", html, flags=re.IGNORECASE)
        self.assertTrue(style_elements)
        self.assertTrue(
            all(f'nonce="{nonce}"' in tag for tag in [*inline_scripts, *style_elements])
        )
        self.assertNotRegex(html, r"\son[a-z]+\s*=\s*[\"']")
        self.assertNotIn("'unsafe-eval'", header)
        self.assertIn("/static/admin/js/i2g-admin-theme-runtime.js", html)
        self.assertLess(
            html.index("/static/unfold/js/htmx/htmx.js"),
            html.index("/static/unfold/js/app.js"),
        )


class CSPReportEndpointTests(TestCase):
    """Cover the csp_report view that logs browser violation reports."""

    def setUp(self):
        self.factory = RequestFactory()
        cache.clear()

    def _post(self, body, content_type="application/json"):
        request = self.factory.post("/csp-report/", data=body, content_type=content_type)
        return csp_report(request)

    def test_valid_report_is_logged_with_sanitized_fields(self):
        body = json.dumps(
            {
                "csp-report": {
                    "violated-directive": "script-src",
                    "blocked-uri": "https://user:secret@evil.example/x\n.js?token=secret#fragment",
                    "document-uri": "https://site.example/mail/unsubscribe/sensitive-token/?next=secret",
                    "source-file": "https://site.example/app.js",
                }
            }
        )
        with patch("apps.core.middleware.csp_report.logger.warning") as warn:
            response = self._post(body)
        self.assertEqual(response.status_code, 204)
        warn.assert_called_once()
        # The newline in blocked-uri must be sanitized out of the logged args.
        logged_args = warn.call_args.args
        self.assertIn("script-src", logged_args)
        self.assertTrue(all("\n" not in str(a) for a in logged_args))
        self.assertTrue(all("secret" not in str(a) for a in logged_args))
        self.assertTrue(all("token=" not in str(a) for a in logged_args))
        self.assertTrue(all("sensitive-token" not in str(a) for a in logged_args))
        self.assertIn("https://site.example/mail/unsubscribe/<redacted>/", logged_args)

    def test_url_with_invalid_port_does_not_fall_back_to_logging_secrets(self):
        body = json.dumps(
            {
                "csp-report": {
                    "effective-directive": "connect-src",
                    "blocked-uri": "https://user:secret@evil.example:bad/path?token=secret",
                }
            }
        )

        with patch("apps.core.middleware.csp_report.logger.warning") as warn:
            response = self._post(body)

        self.assertEqual(response.status_code, 204)
        logged_args = warn.call_args.args
        self.assertTrue(all("secret" not in str(value) for value in logged_args))
        self.assertTrue(all("token=" not in str(value) for value in logged_args))

    def test_falls_back_to_effective_directive(self):
        body = json.dumps({"csp-report": {"effective-directive": "img-src"}})
        with patch("apps.core.middleware.csp_report.logger.warning") as warn:
            response = self._post(body)
        self.assertEqual(response.status_code, 204)
        self.assertIn("img-src", warn.call_args.args)

    def test_unparseable_body_returns_204_and_warns(self):
        with patch("apps.core.middleware.csp_report.logger.warning") as warn:
            response = self._post(b"\xff\xfe not json", content_type="application/json")
        self.assertEqual(response.status_code, 204)
        self.assertIn("unparseable body", warn.call_args.args[0])

    def test_missing_csp_report_object_returns_204(self):
        body = json.dumps({"something-else": True})
        with patch("apps.core.middleware.csp_report.logger.warning") as warn:
            response = self._post(body)
        self.assertEqual(response.status_code, 204)
        self.assertIn("missing 'csp-report' object", warn.call_args.args[0])

    def test_non_dict_payload_returns_204(self):
        body = json.dumps(["not", "a", "dict"])
        with patch("apps.core.middleware.csp_report.logger.warning") as warn:
            response = self._post(body)
        self.assertEqual(response.status_code, 204)
        self.assertIn("missing 'csp-report' object", warn.call_args.args[0])

    def test_unexpected_error_is_caught(self):
        # Force an exception after parsing by making .get raise via a bad object.
        request = self.factory.post("/csp-report/", data="{}", content_type="application/json")
        with (
            patch("apps.core.middleware.csp_report.json.loads", side_effect=RuntimeError("boom")),
            patch("apps.core.middleware.csp_report.logger.exception") as exc_log,
        ):
            response = csp_report(request)
        self.assertEqual(response.status_code, 204)
        exc_log.assert_called_once()

    def test_get_method_not_allowed(self):
        # require_POST decorator rejects GET via the URL dispatcher.
        client = Client()
        response = client.get("/csp-report/")
        self.assertEqual(response.status_code, 405)

    @override_settings(CSP_REPORT_RATE_LIMIT=1, CSP_REPORT_RATE_WINDOW_SECONDS=60)
    def test_reports_are_rate_limited_without_logging_attacker_content(self):
        body = json.dumps({"csp-report": {"effective-directive": "img-src"}})
        with patch("apps.core.middleware.csp_report.logger.warning") as warn:
            first = self._post(body)
            second = self._post(body)

        self.assertEqual(first.status_code, 204)
        self.assertEqual(second.status_code, 204)
        warn.assert_called_once()

    def test_oversized_report_is_rejected(self):
        response = self._post(json.dumps({"csp-report": {"blocked-uri": "x" * 5000}}))

        self.assertEqual(response.status_code, 413)
