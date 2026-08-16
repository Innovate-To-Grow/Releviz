"""
Map of the service subsystems that live under ``apps.core``.

``core`` is the framework app, but its ``services/`` tree also holds subsystems
that ``core`` itself does not use — they are here because no single consumer app
owns them. Read this before adding a module: put it in the owning app unless it
is genuinely shared. Consumers below are the apps that import each path today
(verified, excluding ``core``'s own modules).

======================  ==================================================  ==================================================
Subsystem               What it is                                          Importing apps
======================  ==================================================  ==================================================
``aws/``                Shared AWS credential resolution + SES delivery      ``authn``, ``mail``
``background_jobs/``    Durable outbox: queue, worker, retry, rate limit     ``authn``
``helpers/``            In-process task runner + sheet formula safety       ``authn``
======================  ==================================================  ==================================================

Structure limits are enforced by
``apps/core/tests/services/test_core_services_structure.py``: at most 200 lines
per file and 8 ``.py`` files per directory in this tree.
"""
