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
``aws/``                Shared AWS credential resolution + SNS SMS send      ``authn``, ``event``, ``mail``
``background_jobs/``    Durable outbox: queue, worker, retry, rate limit     ``authn``, ``cms``, ``event``, ``mail``
``bedrock/``            Amazon Bedrock LLM client (converse + streaming)     ``mail``, ``projects``, ``system_intelligence``
``db_tools/``           Read-only ORM sandbox exposed as AI assistant tools  ``cli_admin``, ``system_intelligence``
``helpers/``            In-process task runner + sheet formula safety       ``authn``, ``event``, ``mail``, ``system_intelligence``
======================  ==================================================  ==================================================

Extracting ``background_jobs``, ``bedrock`` and ``db_tools`` into their own apps
would be a cleaner layering, but it needs new Django app labels — and app labels
are stored **in the database** (``Member.admin_apps``, read by
``apps.core.utils.access``), so it requires a data migration. See
``docs/architecture/repository-structure.md`` for the deferred plan.

Structure limits are enforced by
``apps/core/tests/services/test_core_services_structure.py``: at most 200 lines
per file and 8 ``.py`` files per directory in this tree.
"""
