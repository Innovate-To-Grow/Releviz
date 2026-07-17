# Scheduling Slot Model

## Event Configuration

An event stores wall-clock start and end values as minutes after midnight, a `slot_minutes` value of
15 or 30, and whether the window continues into the next day. New events cannot use equal start and
end times. An end time earlier than the start time creates an overnight window.

Events may use:

- selected weekdays for a recurring weekly template
- up to 31 explicit ISO dates
- up to 1,000 total availability slots

The slot limit bounds event-detail responses, participant availability arrays, and aggregation work.
It still permits a seven-day, 24-hour weekly template at 15-minute granularity and 31 eight-hour
specific dates at 15-minute granularity.

## Authoritative Ordering

The backend builds `slotGroups` and assigns every slot one unique, zero-based `index`. Availability
arrays use those indices directly and are flattened in group-major order:

1. groups are ordered by selected weekday or explicit date
2. slots are ordered by real elapsed time within each group
3. the array value at a slot's `index` is that participant's availability for the slot

Clients must not infer a fixed seven-column or hourly layout. The event response includes
`slotCount`, `slotMinutes`, `crossesMidnight`, and the authoritative `slotGroups`. Dashboard list
responses omit `slotGroups` to avoid transferring grid detail that the dashboard does not use.

Participant availability is stored in native JSON arrays in
`availability_inperson` and `availability_virtual`. API writes reject stringified JSON and require
arrays whose length exactly matches `slotCount`; every value must be a number from 0 through 1.

## Weekly and Specific-Date Semantics

Weekly groups represent recurring local wall-clock templates. Their slots contain local start/end
times and day offsets but no absolute timestamp. A recurring final-time selection that is ambiguous
or nonexistent in the event timezone is rejected.

Specific-date groups are resolved against the event's IANA timezone. Each slot includes absolute UTC
start/end timestamps, UTC offsets, local start/end times, day offsets, and the local `fold` value.
Consequently:

- spring-forward groups can contain a local-clock jump while preserving a real 15- or 30-minute
  elapsed slot
- fall-back groups contain distinct slots for repeated local times
- overnight groups can end on the following local date

Finalization for a specific-date event must match authoritative absolute slot boundaries exactly.
This prevents duplicated fall-back times from being conflated.

## Legacy Migration

Migration `0006_minute_slots_and_native_availability` converts the old hourly JSON-text schedule:

- weekly values are reordered from the old fixed-week layout into selected-day group-major order
- each legacy hourly value expands into two 30-minute values
- specific dates are mapped through real timezone-aware half-hour slots, including DST gaps and
  repeated hours
- legacy `00:00`-to-`24:00` events retain full-day meaning through `spans_next_day`
- malformed or wrong-shaped legacy schedules become empty native arrays and are excluded by
  authoritative aggregation validation

The migration has automated forward-migration coverage and passes against both SQLite and
PostgreSQL.

## Validation Evidence

Automated coverage includes 15- and 30-minute events, selected weekdays, specific dates,
cross-midnight windows, spring-forward and fall-back behavior, invalid local boundaries, migration
of full-day legacy data, native-array API validation, aggregation, final-time matching, PostgreSQL,
and the real browser workflow.
