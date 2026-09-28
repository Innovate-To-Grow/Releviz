#!/usr/bin/env python3
"""Fail when a frontend page or backend endpoint has no E2E coverage.

Two checks keep the Playwright suite from silently losing reach:

``routes``
    Every Next.js page under ``src/web/app`` must be referenced by the E2E
    suite (a URL string such as ``"/event?code=`` or an escaped URL regex such
    as ``/\\/create$/``), or be listed in ``ROUTE_EXEMPTIONS`` with a reason.

``endpoints --hits <log>``
    Every Django URL route must appear in the log that
    ``E2EEndpointCoverageMiddleware`` writes during a full browser run, or be
    listed in ``ENDPOINT_EXEMPTIONS`` with a reason. The custom admin routes in
    ``REQUIRED_ADMIN_ROUTES`` must be reached too. An exempted route that the
    run did reach fails the check, so the exemption list cannot go stale.

The inventory is read from the URL modules with ``ast`` so the check needs no
Django installation.
"""

from __future__ import annotations

import argparse
import ast
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB_APP_DIR = ROOT / "src/web/app"
E2E_DIR = ROOT / "src/e2e"
API_DIR = ROOT / "src/api"
ROOT_URLCONF = API_DIR / "config/urls.py"

# Pages that no browser test can reach, with the reason.
ROUTE_EXEMPTIONS: dict[str, str] = {}

# Backend routes that no E2E test reaches, with the reason. Only routes that
# are unsafe on the shared E2E database belong here: a route with no frontend
# caller is still exercised through the API in src/e2e/api-surface.spec.js.
ENDPOINT_EXEMPTIONS: dict[str, str] = {
    "maintenance/bypass/": (
        "switches the whole site's maintenance state, which every parallel "
        "spec shares; covered by apps/core/tests/views/test_maintenance_bypass.py"
    ),
}

# The custom admin views (added by ModelAdmin.get_urls, so absent from the URL
# modules) that must stay covered.
REQUIRED_ADMIN_ROUTES: tuple[str, ...] = (
    "admin/authn/admininvitation/add/",
    "admin/authn/admininvitation/confirm-change/",
    "admin/authn/member/<path:object_id>/impersonate/",
    "admin/authn/member/confirm-action/",
    "admin/authn/member/export-excel/",
    "admin/authn/member/import-excel/",
    "admin/authn/member/import-template/",
    "admin/mail/emailproviderconfig/send-test-email/",
)

URL_BOUNDARY = r"(?=$|[?#\"'`/\s)\\$])"


def discover_frontend_routes(app_dir: Path = WEB_APP_DIR) -> list[str]:
    """Return every page route, dropping route groups and optional catch-alls."""
    routes = set()
    for page in app_dir.rglob("page.js"):
        segments = []
        for part in page.relative_to(app_dir).parent.parts:
            if part.startswith("(") and part.endswith(")"):
                continue
            if part.startswith("[[...") and part.endswith("]]"):
                continue
            segments.append(part)
        routes.add("/" + "/".join(segments))
    return sorted(routes)


def e2e_sources(e2e_dir: Path = E2E_DIR) -> str:
    """Concatenate the suite's specs and helpers, but not its config."""
    return "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted(e2e_dir.rglob("*.js"))
        if path.name != "playwright.config.js" and "node_modules" not in path.parts
    )


def route_is_referenced(route: str, source: str) -> bool:
    """True when the suite names the route as a URL string or URL regex."""
    if route == "/":
        return bool(
            re.search(r"""goto\(\s*["'`]/["'`]""", source)
            or re.search(r"toHaveURL\(\s*/\\/\$/", source)
        )
    plain = re.escape(route)
    escaped = re.escape(route.replace("/", "\\/"))
    pattern = rf"(?:[\"'`]|\$\{{[^}}]*\}}|//[^\s\"'`/]+){plain}{URL_BOUNDARY}"
    regex_literal = rf"{escaped}{URL_BOUNDARY}"
    return bool(re.search(pattern, source) or re.search(regex_literal, source))


def audit_routes(
    routes: list[str],
    source: str,
    exemptions: dict[str, str],
) -> list[str]:
    problems = []
    for route in routes:
        referenced = route_is_referenced(route, source)
        if route in exemptions and referenced:
            problems.append(f"{route} is referenced by the E2E suite; remove its exemption")
        elif route not in exemptions and not referenced:
            problems.append(f"{route} is not referenced by any E2E spec")
    for route in sorted(set(exemptions) - set(routes)):
        problems.append(f"{route} is exempted but is not a page route")
    return problems


def _string(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _module_urlpatterns(tree: ast.Module) -> list[ast.Call]:
    """The ``path(...)`` calls of the module-level ``urlpatterns = [...]``."""
    for node in tree.body:
        if (
            isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id == "urlpatterns"
                for target in node.targets
            )
            and isinstance(node.value, ast.List)
        ):
            return [
                element
                for element in node.value.elts
                if isinstance(element, ast.Call)
                and isinstance(element.func, ast.Name)
                and element.func.id in {"path", "re_path"}
            ]
    return []


def _include_target(call: ast.Call) -> str | None:
    if (
        len(call.args) > 1
        and isinstance(call.args[1], ast.Call)
        and isinstance(call.args[1].func, ast.Name)
        and call.args[1].func.id == "include"
        and call.args[1].args
    ):
        return _string(call.args[1].args[0])
    return None


def _is_admin_site(call: ast.Call) -> bool:
    return (
        len(call.args) > 1
        and isinstance(call.args[1], ast.Attribute)
        and call.args[1].attr == "urls"
    )


def parse_url_inventory(
    urlconf: Path = ROOT_URLCONF,
    api_dir: Path = API_DIR,
) -> list[str]:
    """Every concrete route (as Django's resolver reports it), admin site excluded."""
    routes = set()
    tree = ast.parse(urlconf.read_text(encoding="utf-8"))
    for call in _module_urlpatterns(tree):
        prefix = _string(call.args[0]) if call.args else None
        if prefix is None or _is_admin_site(call):
            continue
        module = _include_target(call)
        if module is None:
            routes.add(prefix)
            continue
        module_file = api_dir / (module.replace(".", "/") + ".py")
        included = ast.parse(module_file.read_text(encoding="utf-8"))
        for child in _module_urlpatterns(included):
            route = _string(child.args[0]) if child.args else None
            if route is not None:
                routes.add(prefix + route)
    return sorted(routes)


def read_hits(log: Path) -> dict[str, Counter]:
    """Map each logged route to a count of the methods that reached it."""
    hits: dict[str, Counter] = defaultdict(Counter)
    if not log.exists():
        return hits
    for line in log.read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            hits[parts[1]][parts[0]] += 1
    return hits


def audit_endpoints(
    inventory: list[str],
    hits: dict[str, Counter],
    exemptions: dict[str, str],
    required: tuple[str, ...],
) -> list[str]:
    problems = []
    for route in inventory:
        reached = route in hits
        if route in exemptions and reached:
            problems.append(f"/{route} was reached by the E2E run; remove its exemption")
        elif route not in exemptions and not reached:
            problems.append(f"/{route} was not reached by any E2E test")
    for route in sorted(set(exemptions) - set(inventory)):
        problems.append(f"/{route} is exempted but is not a URL route")
    for route in required:
        if route not in hits:
            problems.append(f"/{route} (admin) was not reached by any E2E test")
    return problems


def endpoint_summary(
    inventory: list[str],
    hits: dict[str, Counter],
    exemptions: dict[str, str],
    required: tuple[str, ...],
) -> str:
    covered = [route for route in inventory if route in hits]
    lines = [
        "## E2E endpoint coverage",
        "",
        f"{len(covered)} of {len(inventory)} API routes reached, "
        f"{len(exemptions)} exempted, {len(required)} admin routes required.",
        "",
        "| Route | Methods reached |",
        "|---|---|",
    ]
    for route in [*inventory, *required]:
        if route in hits:
            methods = ", ".join(
                f"{method} ×{count}" for method, count in sorted(hits[route].items())
            )
        elif route in exemptions:
            methods = f"exempt: {exemptions[route]}"
        else:
            methods = "**not reached**"
        lines.append(f"| `/{route}` | {methods} |")
    return "\n".join(lines) + "\n"


def write_summary(text: str) -> None:
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(text)


def report(problems: list[str], ok_message: str) -> int:
    if problems:
        print("E2E coverage audit failed:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print(ok_message)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("routes", help="check that every page route is referenced")
    endpoints = commands.add_parser("endpoints", help="check the endpoint hit log")
    endpoints.add_argument("--hits", type=Path, required=True)
    args = parser.parse_args(argv)

    if args.command == "routes":
        routes = discover_frontend_routes()
        problems = audit_routes(routes, e2e_sources(), ROUTE_EXEMPTIONS)
        return report(problems, f"All {len(routes)} page routes are referenced by E2E specs.")

    inventory = parse_url_inventory()
    hits = read_hits(args.hits)
    summary = endpoint_summary(inventory, hits, ENDPOINT_EXEMPTIONS, REQUIRED_ADMIN_ROUTES)
    print(summary)
    write_summary(summary)
    problems = audit_endpoints(inventory, hits, ENDPOINT_EXEMPTIONS, REQUIRED_ADMIN_ROUTES)
    return report(problems, "Every API route was reached by the E2E run.")


if __name__ == "__main__":
    raise SystemExit(main())
