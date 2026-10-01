import io
import os
import tempfile
from collections import Counter
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from scripts.ci import audit_e2e_coverage as audit


def write(root: Path, relative: str, text: str = "") -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class FrontendRouteTests(TestCase):
    def test_discovers_pages_without_groups_or_optional_catch_alls(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            for page in (
                "page.js",
                "event/page.js",
                "(marketing)/terms/page.js",
                "sign-in/[[...sign-in]]/page.js",
                "event/layout.js",
            ):
                write(app, page)

            self.assertEqual(
                audit.discover_frontend_routes(app),
                ["/", "/event", "/sign-in", "/terms"],
            )

    def test_reference_forms_and_boundaries(self):
        source = "\n".join(
            [
                "await page.goto(`/event?code=${code}`);",
                "await expect(page).toHaveURL(/\\/create$/);",
                "await page.goto(`${FRONTEND_URL}/settings#profile`);",
                'const link = "https://app.example/recover";',
                "await request.post(`${BACKEND_URL}/authn/login/`);",
            ]
        )

        self.assertTrue(audit.route_is_referenced("/event", source))
        self.assertTrue(audit.route_is_referenced("/create", source))
        self.assertTrue(audit.route_is_referenced("/settings", source))
        self.assertTrue(audit.route_is_referenced("/recover", source))
        # "/authn/login/" is a backend path, not the /login page.
        self.assertFalse(audit.route_is_referenced("/login", source))
        # "/events" must not count as a reference to "/event" and vice versa.
        self.assertFalse(audit.route_is_referenced("/events", source))
        self.assertFalse(audit.route_is_referenced("/", source))
        self.assertTrue(audit.route_is_referenced("/", 'await page.goto("/");'))
        self.assertTrue(audit.route_is_referenced("/", "await expect(page).toHaveURL(/\\/$/);"))

    def test_audit_routes_reports_missing_stale_and_unknown_exemptions(self):
        problems = audit.audit_routes(
            ["/", "/event", "/terms"],
            'page.goto("/"); page.goto("/event?code=A");',
            {"/event": "reason", "/gone": "reason"},
        )

        self.assertEqual(
            problems,
            [
                "/event is referenced by the E2E suite; remove its exemption",
                "/terms is not referenced by any E2E spec",
                "/gone is exempted but is not a page route",
            ],
        )

    def test_e2e_sources_skip_the_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root, "a.spec.js", "spec")
            write(root, "helpers/b.js", "helper")
            write(root, "playwright.config.js", "config")

            self.assertEqual(audit.e2e_sources(root), "spec\nhelper")


URLCONF = """
from django.conf import settings
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/login/", AdminLoginView.as_view(), name="admin-login"),
    path("admin/", admin.site.urls),
    path("authn/", include("apps.authn.urls")),
    path("", include("apps.scheduling.urls")),
    helper(),
]

if settings.ENABLE_LEGACY_API_PREFIX:
    urlpatterns += [path("api/", include("apps.scheduling.urls"))]
"""


class EndpointInventoryTests(TestCase):
    def test_parses_prefixes_and_skips_the_admin_site_and_legacy_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            api = Path(directory)
            urlconf = write(api, "config/urls.py", URLCONF)
            write(
                api,
                "apps/authn/urls.py",
                'urlpatterns = [path("login/", LoginView.as_view()), path(ROUTE, View)]',
            )
            write(
                api,
                "apps/scheduling/urls.py",
                'x = 1\nurlpatterns = [path("events", EventsView.as_view()), '
                're_path(r"^old$", Old), other()]',
            )

            self.assertEqual(
                audit.parse_url_inventory(urlconf, api),
                ["^old$", "admin/login/", "authn/login/", "events"],
            )

    def test_inventory_of_this_repository_includes_known_routes(self):
        inventory = audit.parse_url_inventory()

        self.assertIn("events/roster/<str:participant_id>/schedule", inventory)
        self.assertIn("authn/email-auth/verify-code/", inventory)
        self.assertIn("admin/login/", inventory)
        self.assertFalse(any(route.startswith("api/") for route in inventory))


class EndpointAuditTests(TestCase):
    def test_reads_hits_and_ignores_malformed_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            log = write(
                Path(directory),
                "hits.log",
                "GET\tevents\t200\nPUT\tevents\t409\nGET\tevents\t200\nbroken\n",
            )

            hits = audit.read_hits(log)

        self.assertEqual(hits, {"events": Counter({"GET": 2, "PUT": 1})})
        self.assertEqual(audit.read_hits(Path(directory) / "missing.log"), {})

    def test_audit_endpoints_reports_every_problem_kind(self):
        hits = {"events": Counter({"GET": 1}), "health": Counter({"GET": 1})}

        problems = audit.audit_endpoints(
            ["events", "health", "weights"],
            hits,
            {"health": "probe", "stale": "gone"},
            ("admin/x/",),
        )

        self.assertEqual(
            problems,
            [
                "/health was reached by the E2E run; remove its exemption",
                "/weights was not reached by any E2E test",
                "/stale is exempted but is not a URL route",
                "/admin/x/ (admin) was not reached by any E2E test",
            ],
        )

    def test_summary_lists_methods_exemptions_and_gaps(self):
        summary = audit.endpoint_summary(
            ["events", "health", "weights"],
            {"events": Counter({"PUT": 1, "GET": 3}), "admin/x/": Counter({"GET": 1})},
            {"health": "probe"},
            ("admin/x/",),
        )

        self.assertIn("1 of 3 API routes reached, 1 exempted, 1 admin routes required.", summary)
        self.assertIn("| `/events` | GET ×3, PUT ×1 |", summary)
        self.assertIn("| `/health` | exempt: probe |", summary)
        self.assertIn("| `/weights` | **not reached** |", summary)
        self.assertIn("| `/admin/x/` | GET ×1 |", summary)


class CommandLineTests(TestCase):
    def run_main(self, argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = audit.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_routes_mode_passes_and_fails(self):
        with (
            patch.object(audit, "discover_frontend_routes", return_value=["/", "/event"]),
            patch.object(audit, "e2e_sources", return_value='goto("/"); goto("/event?c=1")'),
        ):
            self.assertEqual(self.run_main(["routes"])[0], 0)
        with (
            patch.object(audit, "discover_frontend_routes", return_value=["/terms"]),
            patch.object(audit, "e2e_sources", return_value=""),
        ):
            code, _, stderr = self.run_main(["routes"])
        self.assertEqual(code, 1)
        self.assertIn("/terms is not referenced by any E2E spec", stderr)

    def test_endpoints_mode_writes_the_step_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = write(root, "hits.log", "GET\tevents\t200\n")
            summary = root / "summary.md"
            with (
                patch.object(audit, "parse_url_inventory", return_value=["events"]),
                patch.object(audit, "ENDPOINT_EXEMPTIONS", {}),
                patch.object(audit, "REQUIRED_ADMIN_ROUTES", ()),
                patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}),
            ):
                code, stdout, _ = self.run_main(["endpoints", "--hits", str(log)])

            self.assertEqual(code, 0)
            self.assertIn("Every API route was reached by the E2E run.", stdout)
            self.assertIn("1 of 1 API routes reached", summary.read_text(encoding="utf-8"))

    def test_endpoints_mode_without_a_step_summary_reports_gaps(self):
        with tempfile.TemporaryDirectory() as directory:
            log = write(Path(directory), "hits.log", "")
            with (
                patch.object(audit, "parse_url_inventory", return_value=["events"]),
                patch.object(audit, "ENDPOINT_EXEMPTIONS", {}),
                patch.object(audit, "REQUIRED_ADMIN_ROUTES", ()),
                patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": ""}),
            ):
                code, _, stderr = self.run_main(["endpoints", "--hits", str(log)])

        self.assertEqual(code, 1)
        self.assertIn("/events was not reached by any E2E test", stderr)
