"""Push change notifications to open organizer workspaces.

Postgres triggers announce every committed write to an event on the
``releviz_events`` channel. One ``LISTEN`` connection per worker process
feeds an in-process broker, and each open event stream waits on the broker
for its event and answers with a Server-Sent Events frame that tells the
workspace to compare its digest.

Everything here imports cleanly without a database, so the availability check
can turn a request away on SQLite or under WSGI before anything is opened.
"""

from .availability import live_stream_available
from .broker import ChangeBroker, Subscription, get_broker, reset_broker
from .listener import CHANNEL, PostgresListener, listener_connection_kwargs
from .stream import event_changes, sse, stream_deadline

__all__ = [
    "CHANNEL",
    "ChangeBroker",
    "PostgresListener",
    "Subscription",
    "event_changes",
    "get_broker",
    "listener_connection_kwargs",
    "live_stream_available",
    "reset_broker",
    "sse",
    "stream_deadline",
]
