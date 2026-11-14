"""Record which URL routes a browser test run reaches (E2E settings only)."""

import os
import threading

_write_lock = threading.Lock()


class E2EEndpointCoverageMiddleware:
    """Append ``METHOD<TAB>route<TAB>status`` for every resolved request.

    ``config.settings.e2e`` installs this only when ``E2E_ENDPOINT_LOG`` names a
    file. The CI coverage audit (``scripts/ci/audit_e2e_coverage.py``) compares
    the log with the URL inventory, so an endpoint no browser test reaches
    fails the build instead of silently losing coverage. The route is Django's
    matched pattern, never the concrete path, so no identifiers are recorded.
    """

    def __init__(self, get_response):
        self.get_response = get_response
        self.log_path = os.environ.get("E2E_ENDPOINT_LOG", "")

    def __call__(self, request):
        response = self.get_response(request)
        route = getattr(getattr(request, "resolver_match", None), "route", None)
        if self.log_path and route is not None:
            line = f"{request.method}\t{route}\t{response.status_code}\n"
            with _write_lock, open(self.log_path, "a", encoding="utf-8") as handle:
                handle.write(line)
        return response
