"""Small in-process fallback for installations without a durable worker.

The durable outbox remains the preferred execution path.  Some deployments do
not run a worker yet, though, and request handlers must not perform provider I/O
inline while that rollout flag is disabled.  This helper keeps those legacy
fallbacks non-blocking and gives every task its own clean Django connection.
"""

import logging
import threading
from collections.abc import Callable

from django.db import close_old_connections

logger = logging.getLogger(__name__)


def start_in_process_task(
    target: Callable,
    *args,
    name: str,
    daemon: bool = True,
    best_effort_start: bool = False,
) -> threading.Thread | None:
    """Run ``target`` on a fresh background thread and return immediately.

    ``best_effort_start`` is for secondary notifications and synchronization
    callbacks whose failure must not turn an already-committed user operation
    into a 500 response. Campaign dispatch deliberately leaves it disabled so
    its caller can persist an observable ``failed`` state when a thread cannot
    be created.
    """

    def run() -> None:
        close_old_connections()
        try:
            target(*args)
        except Exception:  # noqa: BLE001 - task boundary must not escape the thread.
            logger.exception("In-process background task %s failed", name)
        finally:
            close_old_connections()

    try:
        thread = threading.Thread(target=run, name=name, daemon=daemon)
        thread.start()
    except Exception:  # noqa: BLE001 - OS thread exhaustion is an execution boundary.
        if not best_effort_start:
            raise
        logger.exception("Unable to start best-effort in-process task %s", name)
        return None
    return thread
