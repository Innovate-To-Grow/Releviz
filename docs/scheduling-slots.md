# Scheduling Slot Model

## Event Configuration

An event stores wall-clock start and end values as minutes after midnight, a `slot_minutes` value of
15 or 30, and whether the window continues into the next day. New events cannot use equal start and
end times. An end time earlier than the start time creates an overnight window.

`meeting_duration_minutes` defaults to 30, must be 15–480, must be an integer multiple of
`slot_minutes`, and must fit within at least one authoritative slot group. Meeting duration is not a
display hint: recommendations and finalization both enforce the exact continuous interval length.

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

Paginated roster summaries never include these arrays. An organizer loads one participant's arrays
from `GET /events/roster/{participantId}/schedule` only when opening the schedule drawer.

## Continuous recommendations

For every configured channel and every contiguous window of
`meeting_duration_minutes / slot_minutes` slots in one authoritative group, each person's score is
the minimum of their availability across the entire window. Sliding-window minima keep the ranking
pass linear in participants × slots × channels.

Candidates are ordered by:

1. highest weighted availability;
2. highest unweighted availability;
3. most fully available people;
4. earliest configured time (then stable channel/window order).

Only the first ten candidates are returned. Included responses with weight zero participate in the
unweighted/full-availability views but not the weighted denominator. Excluded, hidden, unanswered,
and invalid-shape responses do not contribute. There is no required-participant conflict metric.

Final confirmation must select exactly the configured duration, use consecutive authoritative slot
indices, and remain inside one group. An interval may cross local midnight when the group itself is
overnight; it cannot cross between weekday/date groups.

## Versioned results

Any result-affecting write increments `results_revision` and marks the event's single result
snapshot `refreshing`. The result worker coalesces multiple writes, calculates the target revision,
then verifies the event revision again before publishing. A calculation for an older revision never
overwrites newer work.

`GET /events/results` returns `fresh`, `refreshing`, or `failed` with requested/computed revisions
and the last successful generation time. Clients poll during refresh and may continue to label/show
the previous payload. See [`worker-runbook.md`](worker-runbook.md).

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

## Historical Slot Migration

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

That history explains the slot representation but is not a data-compatibility promise for the
1,000-person roster-scale release. That cutover starts from a new empty database and does not migrate
old accounts, events, schedules, feedback, or delivery configuration.

## Validation Evidence

Automated coverage includes 15- and 30-minute events, continuous durations, selected weekdays,
specific dates, cross-midnight windows, spring-forward and fall-back behavior, group boundaries,
invalid local boundaries, native-array API validation, minimum-window scoring, zero weights, all
excluded/no-window cases, versioned aggregation, final-time matching, PostgreSQL, and the real
browser workflow.
