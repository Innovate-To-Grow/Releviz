#!/usr/bin/env python3
"""Prepare a disposable local PostgreSQL fixture for the HTTP scale runner.

This command writes application rows and a short-lived bearer-token manifest.
It refuses non-PostgreSQL, non-performance-named, or remote databases unless
the operator deliberately opts out of each guard.  It never drops a database.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
import uuid
from datetime import timedelta
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "src" / "backend"
sys.path.insert(0, str(BACKEND_ROOT))

PARTICIPANT_TOTAL = 1_000
SLOT_TOTAL = 1_000
LOCAL_DATABASE_HOSTS = {"", "localhost", "127.0.0.1", "::1"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a disposable 1,000-person/1,000-slot PostgreSQL HTTP fixture."
    )
    parser.add_argument(
        "--settings",
        default="config.settings.test_postgres",
        help="Django settings module (default: config.settings.test_postgres).",
    )
    parser.add_argument("--event-code", default="PERF1000")
    parser.add_argument(
        "--confirm-code",
        required=True,
        help="Must exactly match --event-code to authorize database writes.",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("/tmp/releviz-perf1000-manifest.json"),
        help="Secret output manifest (default: /tmp/releviz-perf1000-manifest.json).",
    )
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Delete and recreate only an existing event with this exact code.",
    )
    parser.add_argument(
        "--allow-remote-database",
        action="store_true",
        help="Override the loopback database-host guard.",
    )
    parser.add_argument(
        "--allow-nonperformance-database-name",
        action="store_true",
        help="Override the requirement that the database name contain 'test' or 'perf'.",
    )
    parser.add_argument(
        "--allow-workspace-manifest",
        action="store_true",
        help="Allow the short-lived bearer-token manifest to be written inside the repository.",
    )
    args = parser.parse_args()
    args.event_code = args.event_code.strip().upper()
    if not args.event_code or len(args.event_code) > 16:
        parser.error("--event-code must contain 1-16 characters")
    if args.confirm_code.strip().upper() != args.event_code:
        parser.error("--confirm-code must exactly match --event-code")
    try:
        args.manifest.resolve().relative_to(REPOSITORY_ROOT)
    except ValueError:
        pass
    else:
        if not args.allow_workspace_manifest:
            parser.error(
                "refusing to write bearer tokens inside the repository; choose /tmp or pass "
                "--allow-workspace-manifest"
            )
    return args


def configure_django(settings_module: str) -> None:
    os.environ["DJANGO_SETTINGS_MODULE"] = settings_module
    import django

    django.setup()


def assert_safe_database(args: argparse.Namespace) -> dict:
    from django.db import connection

    connection.ensure_connection()
    details = connection.settings_dict
    host = str(details.get("HOST") or "").strip().lower()
    database_name = str(details.get("NAME") or "")
    if connection.vendor != "postgresql":
        raise RuntimeError(
            f"refusing database vendor {connection.vendor!r}; this scenario requires PostgreSQL"
        )
    if host not in LOCAL_DATABASE_HOSTS and not args.allow_remote_database:
        raise RuntimeError(
            f"refusing non-loopback PostgreSQL host {host!r}; use --allow-remote-database only "
            "for an explicitly isolated performance database"
        )
    lowered_name = database_name.lower()
    if not any(marker in lowered_name for marker in ("test", "perf")) and not (
        args.allow_nonperformance_database_name
    ):
        raise RuntimeError(
            f"refusing database {database_name!r}; its name must contain 'test' or 'perf'"
        )
    return {
        "vendor": connection.vendor,
        "host": host or "local-socket",
        "name": database_name,
    }


def member_for_email(email: str, *, first_name: str, last_name: str):
    from django.contrib.auth import get_user_model

    from apps.authn.models import ContactEmail

    Member = get_user_model()
    contact = (
        ContactEmail.objects.select_related("member")
        .filter(email_address=email)
        .first()
    )
    if contact is not None:
        member = contact.member
        if member is None:
            raise RuntimeError(f"contact {email} has no member")
        changed = []
        if member.access_level != Member.AccessLevel.FULL:
            member.access_level = Member.AccessLevel.FULL
            changed.append("access_level")
        if not member.is_active:
            member.is_active = True
            changed.append("is_active")
        if changed:
            member.save(update_fields=changed)
        if not contact.verified:
            contact.verified = True
            contact.save(update_fields=["verified", "updated_at"])
        return member

    member = Member.objects.create_user(
        email=email,
        first_name=first_name,
        last_name=last_name,
        access_level=Member.AccessLevel.FULL,
        is_active=True,
    )
    ContactEmail.objects.create(
        member=member,
        email_address=email,
        email_type="primary",
        verified=True,
    )
    return member


def access_token_for(member, session_id) -> str:
    from rest_framework_simplejwt.tokens import AccessToken

    token = AccessToken.for_user(member)
    token["session_id"] = str(session_id)
    return str(token)


def create_fixture(args: argparse.Namespace) -> dict:
    from django.db import transaction
    from django.utils import timezone

    from apps.authn.models import AuthSession
    from apps.scheduling.models import (
        Event,
        EventResultSnapshot,
        Participant,
        UserEvent,
        Weight,
    )

    now = timezone.now()
    first_date = now.date() + timedelta(days=1)
    specific_dates = [
        (first_date + timedelta(days=offset)).isoformat() for offset in range(25)
    ]

    with transaction.atomic():
        existing = (
            Event.objects.select_for_update().filter(code=args.event_code).first()
        )
        if existing is not None:
            if not args.replace:
                raise RuntimeError(
                    f"event {args.event_code} already exists; rerun with --replace to delete only "
                    "that exact event"
                )
            existing.delete()

        organizer_email = f"scale-organizer+{args.event_code.lower()}@releviz.local"
        organizer = member_for_email(
            organizer_email,
            first_name="Scale",
            last_name="Organizer",
        )
        event = Event.objects.create(
            code=args.event_code,
            name="Releviz 1000-person performance fixture",
            start_minutes=9 * 60,
            end_minutes=19 * 60,
            slot_minutes=15,
            spans_next_day=False,
            days=[],
            mode="mixed",
            organizer=organizer,
            participant_view_permission="realtime",
            day_selection_type="specific_dates",
            specific_dates=specific_dates,
            timezone="UTC",
            access_mode="invite_only",
            meeting_duration_minutes=60,
            status=Event.Status.OPEN,
            opened_at=now,
        )
        UserEvent.objects.get_or_create(member=organizer, event=event, role="organizer")

        members = []
        for participant_index in range(PARTICIPANT_TOTAL):
            ordinal = participant_index + 1
            members.append(
                member_for_email(
                    f"scale-{ordinal:04d}+{args.event_code.lower()}@releviz.local",
                    first_name="Scale",
                    last_name=f"Participant {ordinal:04d}",
                )
            )

        participants = Participant.objects.bulk_create(
            [
                Participant(
                    event=event,
                    member=member,
                    participant_name=f"Scale Participant {index + 1:04d}",
                    availability_inperson=[0.0] * SLOT_TOTAL,
                    availability_virtual=[0.0] * SLOT_TOTAL,
                    group_name=f"Group {(index % 20) + 1:02d}",
                    sort_order=index,
                )
                for index, member in enumerate(members)
            ],
            batch_size=25,
        )
        Weight.objects.bulk_create(
            [
                Weight(
                    event=event,
                    participant=participant,
                    weight=0.0 if index % 20 == 0 else ((index % 10) + 1) / 10,
                    included=True,
                )
                for index, participant in enumerate(participants)
            ],
            batch_size=250,
        )
        UserEvent.objects.bulk_create(
            [
                UserEvent(member=member, event=event, role="participant")
                for member in members
            ],
            batch_size=250,
        )
        EventResultSnapshot.objects.create(
            event=event,
            requested_revision=event.results_revision,
            status=EventResultSnapshot.Status.REFRESHING,
        )

        session_expiry = now + timedelta(minutes=30)
        organizer_session = AuthSession(
            member=organizer,
            refresh_jti=f"scale-{uuid.uuid4()}",
            expires_at=session_expiry,
            last_seen_at=now,
        )
        participant_sessions = [
            AuthSession(
                member=member,
                refresh_jti=f"scale-{uuid.uuid4()}",
                expires_at=session_expiry,
                last_seen_at=now,
            )
            for member in members
        ]
        AuthSession.objects.bulk_create(
            [organizer_session, *participant_sessions],
            batch_size=250,
        )

        manifest = {
            "eventCode": event.code,
            "slotCount": SLOT_TOTAL,
            "participantCount": PARTICIPANT_TOTAL,
            "accessTokenLifetimeNote": (
                "Tokens use the configured short access lifetime; run the HTTP scenario "
                "immediately after preparing this file."
            ),
            "organizer": {
                "memberId": str(organizer.pk),
                "accessToken": access_token_for(organizer, organizer_session.pk),
            },
            "participants": [
                {
                    "memberId": str(member.pk),
                    "participantId": str(participant.pk),
                    "expectedVersion": participant.version,
                    "accessToken": access_token_for(member, session.pk),
                }
                for member, participant, session in zip(
                    members,
                    participants,
                    participant_sessions,
                    strict=True,
                )
            ],
        }
    return manifest


def main() -> int:
    args = parse_args()
    configure_django(args.settings)
    database = assert_safe_database(args)
    manifest = create_fixture(args)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(
        json.dumps(manifest, separators=(",", ":")), encoding="utf-8"
    )
    args.manifest.chmod(stat.S_IRUSR | stat.S_IWUSR)
    print(
        f"Created event {manifest['eventCode']} with {manifest['participantCount']} participants "
        f"and {manifest['slotCount']} slots in PostgreSQL {database['name']!r} "
        f"on {database['host']}."
    )
    print(f"Wrote short-lived bearer-token manifest to {args.manifest} (mode 0600).")
    print("Run the HTTP scenario now, then delete the manifest.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
