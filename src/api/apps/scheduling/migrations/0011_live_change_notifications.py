"""Postgres triggers that announce which events changed.

The organizer workspace's live stream listens on one Postgres channel and
re-reads an event when its primary key arrives. Statement-level AFTER triggers
on every table the workspace renders read the affected event ids out of the
statement's transition table and call pg_notify once per event, which covers
the queryset updates and bulk writes that Django signals never see. Postgres
sends the notifications only when the transaction commits and collapses
identical channel and payload pairs within a transaction, so a thousand-row
import costs one message. Other vendors get nothing: the stream reports itself
unavailable there and the workspace keeps polling.
"""

from django.db import migrations

CHANNEL = "releviz_events"
FUNCTION_NAME = "releviz_notify_event_changed"

# The query that lists the event ids a statement touched, per table. The trigger
# hands it to the function as its only argument, and {rows} names the transition
# table of the event type the trigger fires on.
TABLE_ROW_SOURCES = {
    "scheduling_event": "SELECT DISTINCT id FROM {rows}",
    "scheduling_participant": "SELECT DISTINCT event_id FROM {rows}",
    "scheduling_eventinvitation": "SELECT DISTINCT event_id FROM {rows}",
    "scheduling_weight": "SELECT DISTINCT event_id FROM {rows}",
    "scheduling_eventresultsnapshot": "SELECT DISTINCT event_id FROM {rows}",
    "scheduling_participantgroup": "SELECT DISTINCT event_id FROM {rows}",
    "mail_emaildeliveryrequest": "SELECT DISTINCT event_id FROM {rows}",
    # Account-level mail such as verification codes has no event to announce.
    "mail_emaildeliveryjob": "SELECT DISTINCT event_id FROM {rows} WHERE event_id IS NOT NULL",
    # The membership join table only knows the participant.
    "scheduling_participant_groups": (
        "SELECT DISTINCT p.event_id FROM {rows} r "
        "JOIN scheduling_participant p ON p.id = r.participant_id"
    ),
}

# Postgres refuses transition tables on a trigger that names more than one event
# type, so every table gets one trigger per type.
TRIGGER_EVENTS = {
    "insert": ("INSERT", "NEW", "new_rows"),
    "update": ("UPDATE", "NEW", "new_rows"),
    "delete": ("DELETE", "OLD", "old_rows"),
}

# Every statement below runs with an empty parameter tuple, so none of them may
# contain a percent sign: psycopg would read it as a placeholder.
FUNCTION_SQL = f"""
CREATE OR REPLACE FUNCTION {FUNCTION_NAME}() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed_event_id bigint;
BEGIN
  FOR changed_event_id IN EXECUTE TG_ARGV[0] LOOP
    PERFORM pg_notify('{CHANNEL}', changed_event_id::text);
  END LOOP;
  RETURN NULL;
END $$
"""


def trigger_name(table, event):
    return f"releviz_notify_{table}_{event}"


def drop_trigger_sql(table, event):
    return f"DROP TRIGGER IF EXISTS {trigger_name(table, event)} ON {table}"


def create_trigger_sql(table, event):
    operation, transition, rows = TRIGGER_EVENTS[event]
    row_source = TABLE_ROW_SOURCES[table].format(rows=rows)
    return (
        f"CREATE TRIGGER {trigger_name(table, event)} "
        f"AFTER {operation} ON {table} REFERENCING {transition} TABLE AS {rows} "
        f"FOR EACH STATEMENT EXECUTE FUNCTION {FUNCTION_NAME}('{row_source}')"
    )


def install(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    # Bind parameters cannot represent identifiers or trigger arguments. Every
    # name and query here is a literal from the module constants above.
    schema_editor.execute(  # nosemgrep: python.lang.security.audit.formatted-sql-query.formatted-sql-query,python.sqlalchemy.security.sqlalchemy-execute-raw-query.sqlalchemy-execute-raw-query
        FUNCTION_SQL
    )
    for table in TABLE_ROW_SOURCES:
        for event in TRIGGER_EVENTS:
            schema_editor.execute(  # nosemgrep: python.lang.security.audit.formatted-sql-query.formatted-sql-query,python.sqlalchemy.security.sqlalchemy-execute-raw-query.sqlalchemy-execute-raw-query
                drop_trigger_sql(table, event)
            )
            schema_editor.execute(  # nosemgrep: python.lang.security.audit.formatted-sql-query.formatted-sql-query,python.sqlalchemy.security.sqlalchemy-execute-raw-query.sqlalchemy-execute-raw-query
                create_trigger_sql(table, event)
            )


def uninstall(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    # The triggers depend on the function, so they go first.
    for table in TABLE_ROW_SOURCES:
        for event in TRIGGER_EVENTS:
            schema_editor.execute(  # nosemgrep: python.lang.security.audit.formatted-sql-query.formatted-sql-query,python.sqlalchemy.security.sqlalchemy-execute-raw-query.sqlalchemy-execute-raw-query
                drop_trigger_sql(table, event)
            )
    schema_editor.execute(  # nosemgrep: python.lang.security.audit.formatted-sql-query.formatted-sql-query,python.sqlalchemy.security.sqlalchemy-execute-raw-query.sqlalchemy-execute-raw-query
        f"DROP FUNCTION IF EXISTS {FUNCTION_NAME}()"
    )


class Migration(migrations.Migration):
    # Run outside one transaction so every DROP TRIGGER and CREATE TRIGGER
    # commits on its own. In a single transaction the migration would hold
    # its table locks on all nine tables until the end, taken in a fixed order,
    # and could deadlock with the running email worker or a roster write
    # during a deploy and fail the task start. This way only one table is
    # locked at a time. Every statement is idempotent (CREATE OR REPLACE
    # FUNCTION, DROP TRIGGER IF EXISTS before each CREATE TRIGGER), so
    # rerunning the migration after a partial failure completes the install.
    atomic = False

    dependencies = [
        ("scheduling", "0010_participantgroup_comma_free_names"),
        ("mail", "0002_emaildeliveryjob_provider_call_started_at_and_more"),
    ]

    operations = [migrations.RunPython(install, uninstall)]
