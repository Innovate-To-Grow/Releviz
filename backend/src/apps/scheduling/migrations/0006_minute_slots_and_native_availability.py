import json
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from django.db import migrations, models

import apps.scheduling.models

MINUTES_PER_DAY = 24 * 60


def _parsed_list(value):
    if isinstance(value, list):
        return value
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, list) else None


def _valid_localizations(value, zone):
    candidates = {}
    for fold in (0, 1):
        candidate = value.replace(tzinfo=zone, fold=fold)
        round_trip = candidate.astimezone(UTC).astimezone(zone).replace(tzinfo=None)
        if round_trip == value:
            candidates[candidate.astimezone(UTC)] = candidate
    return [candidates[key] for key in sorted(candidates)]


def _specific_date_half_hour_rows(event, raw_date):
    try:
        base_date = date.fromisoformat(raw_date)
        zone = ZoneInfo(event.timezone)
    except (TypeError, ValueError):
        return None
    start_naive = datetime.combine(base_date, datetime.min.time()) + timedelta(
        hours=event.start_hour
    )
    end_naive = datetime.combine(base_date, datetime.min.time()) + timedelta(hours=event.end_hour)
    starts = _valid_localizations(start_naive, zone)
    ends = _valid_localizations(end_naive, zone)
    if not starts or not ends:
        return None
    current = starts[0].astimezone(UTC)
    finish = ends[-1].astimezone(UTC)
    rows = []
    while current < finish:
        local = current.astimezone(zone)
        rows.append(local.hour - event.start_hour)
        current += timedelta(minutes=30)
    return rows


def _forward_availability(event, value):
    parsed = _parsed_list(value)
    old_hours = event.end_hour - event.start_hour
    if old_hours <= 0:
        return []

    if event.day_selection_type == "specific_dates":
        configured_dates = event.specific_dates if isinstance(event.specific_dates, list) else []
        columns = len(configured_dates)
        if parsed is None or len(parsed) != old_hours * columns:
            return []
        migrated = []
        for column, raw_date in enumerate(configured_dates):
            rows = _specific_date_half_hour_rows(event, raw_date)
            if rows is None:
                return []
            for row in rows:
                if row < 0 or row >= old_hours:
                    return []
                migrated.append(parsed[row * columns + column])
        return migrated

    selected_days = sorted(
        {
            day
            for day in (event.days or [1, 2, 3, 4, 5])
            if isinstance(day, int) and not isinstance(day, bool) and 0 <= day <= 6
        }
    )
    if not selected_days:
        selected_days = [1, 2, 3, 4, 5]
    if parsed is None or len(parsed) != old_hours * 7:
        return []
    migrated = []
    for day in selected_days:
        for row in range(old_hours):
            value_at_hour = parsed[row * 7 + day]
            migrated.extend([value_at_hour, value_at_hour])
    return migrated


def migrate_to_minute_slots(apps, schema_editor):
    Event = apps.get_model("scheduling", "Event")
    Participant = apps.get_model("scheduling", "Participant")

    for event in Event.objects.all().iterator():
        event.start_minutes = (event.start_hour * 60) % MINUTES_PER_DAY
        event.end_minutes = (event.end_hour * 60) % MINUTES_PER_DAY
        event.slot_minutes = 30
        event.spans_next_day = event.end_minutes <= event.start_minutes
        if event.day_selection_type == "days_of_week":
            selected_days = sorted(
                {
                    day
                    for day in (event.days or [1, 2, 3, 4, 5])
                    if isinstance(day, int) and not isinstance(day, bool) and 0 <= day <= 6
                }
            )
            event.days = selected_days or [1, 2, 3, 4, 5]
        event.save(
            update_fields=[
                "start_minutes",
                "end_minutes",
                "slot_minutes",
                "spans_next_day",
                "days",
            ]
        )

        for participant in Participant.objects.filter(event_id=event.pk).iterator():
            participant.availability_inperson = json.dumps(
                _forward_availability(event, participant.availability_inperson)
            )
            participant.availability_virtual = json.dumps(
                _forward_availability(event, participant.availability_virtual)
            )
            participant.save(update_fields=["availability_inperson", "availability_virtual"])


def _backward_availability(event, value):
    parsed = _parsed_list(value)
    old_hours = event.end_hour - event.start_hour
    if parsed is None or old_hours <= 0:
        return []

    if event.day_selection_type == "specific_dates":
        configured_dates = event.specific_dates if isinstance(event.specific_dates, list) else []
        columns = len(configured_dates)
        restored = [0] * (old_hours * columns)
        cursor = 0
        for column, raw_date in enumerate(configured_dates):
            rows = _specific_date_half_hour_rows(event, raw_date)
            if rows is None or cursor + len(rows) > len(parsed):
                return []
            seen = set()
            for row in rows:
                if 0 <= row < old_hours and row not in seen:
                    restored[row * columns + column] = parsed[cursor]
                    seen.add(row)
                cursor += 1
        return restored

    selected_days = sorted(set(event.days or [1, 2, 3, 4, 5]))
    slots_per_group = ((event.end_minutes - event.start_minutes) % MINUTES_PER_DAY) // max(
        event.slot_minutes, 1
    )
    restored = [0] * (old_hours * 7)
    for group_position, day in enumerate(selected_days):
        group_start = group_position * slots_per_group
        for row in range(old_hours):
            slot_offset = row * 60 // max(event.slot_minutes, 1)
            index = group_start + slot_offset
            if index < len(parsed):
                restored[row * 7 + day] = parsed[index]
    return restored


def migrate_to_hour_slots(apps, schema_editor):
    Event = apps.get_model("scheduling", "Event")
    Participant = apps.get_model("scheduling", "Participant")

    for event in Event.objects.all().iterator():
        event.start_hour = event.start_minutes // 60
        if event.spans_next_day:
            event.end_hour = 24
        else:
            event.end_hour = max(event.start_hour + 1, event.end_minutes // 60)
        event.save(update_fields=["start_hour", "end_hour"])
        for participant in Participant.objects.filter(event_id=event.pk).iterator():
            participant.availability_inperson = json.dumps(
                _backward_availability(event, participant.availability_inperson)
            )
            participant.availability_virtual = json.dumps(
                _backward_availability(event, participant.availability_virtual)
            )
            participant.save(update_fields=["availability_inperson", "availability_virtual"])


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0005_event_timezone_finalmeeting_finalizationrequest"),
    ]

    operations = [
        migrations.AddField(
            model_name="event",
            name="start_minutes",
            field=models.PositiveSmallIntegerField(default=540),
        ),
        migrations.AddField(
            model_name="event",
            name="end_minutes",
            field=models.PositiveSmallIntegerField(default=1020),
        ),
        migrations.AddField(
            model_name="event",
            name="slot_minutes",
            field=models.PositiveSmallIntegerField(
                choices=[(15, "15 minutes"), (30, "30 minutes")],
                default=30,
            ),
        ),
        migrations.AddField(
            model_name="event",
            name="spans_next_day",
            field=models.BooleanField(default=False),
        ),
        migrations.AlterField(
            model_name="event",
            name="days",
            field=models.JSONField(default=apps.scheduling.models.default_weekdays),
        ),
        migrations.RenameField(
            model_name="participant",
            old_name="schedule_inperson",
            new_name="availability_inperson",
        ),
        migrations.RenameField(
            model_name="participant",
            old_name="schedule_virtual",
            new_name="availability_virtual",
        ),
        migrations.RunPython(
            migrate_to_minute_slots,
            reverse_code=migrate_to_hour_slots,
        ),
        migrations.AlterField(
            model_name="participant",
            name="availability_inperson",
            field=models.JSONField(default=list),
        ),
        migrations.AlterField(
            model_name="participant",
            name="availability_virtual",
            field=models.JSONField(default=list),
        ),
        migrations.RemoveField(
            model_name="event",
            name="start_hour",
        ),
        migrations.RemoveField(
            model_name="event",
            name="end_hour",
        ),
        migrations.AddConstraint(
            model_name="event",
            constraint=models.CheckConstraint(
                condition=models.Q(start_minutes__gte=0, start_minutes__lt=1440),
                name="event_start_minutes_in_day",
            ),
        ),
        migrations.AddConstraint(
            model_name="event",
            constraint=models.CheckConstraint(
                condition=models.Q(end_minutes__gte=0, end_minutes__lt=1440),
                name="event_end_minutes_in_day",
            ),
        ),
        migrations.AddConstraint(
            model_name="event",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(spans_next_day=True)
                    & models.Q(end_minutes__lte=models.F("start_minutes"))
                )
                | (
                    models.Q(spans_next_day=False)
                    & models.Q(end_minutes__gt=models.F("start_minutes"))
                ),
                name="event_window_direction_is_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="event",
            constraint=models.CheckConstraint(
                condition=models.Q(slot_minutes__in=[15, 30]),
                name="event_slot_minutes_supported",
            ),
        ),
    ]
