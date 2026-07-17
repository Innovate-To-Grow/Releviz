"""Canonical product metrics derived from authoritative domain timestamps."""

from collections import defaultdict
from datetime import timedelta
from statistics import median

from django.db.models import Q
from django.utils import timezone

from apps.core.models import FeedbackSubmission
from apps.messaging.models import EmailDeliveryJob
from apps.scheduling.aggregation import classify_event_responses
from apps.scheduling.models import Event, EventInvitation, Participant


def _rate(numerator: int, denominator: int) -> dict:
    return {
        "numerator": numerator,
        "denominator": denominator,
        "value": round(numerator / denominator, 4) if denominator else None,
    }


def _median_duration(start_end_pairs) -> dict:
    values = [
        (end - start).total_seconds()
        for start, end in start_end_pairs
        if start is not None and end is not None and end >= start
    ]
    return {
        "sampleSize": len(values),
        "medianSeconds": round(median(values), 3) if values else None,
    }


def _occurred_by(value, as_of) -> bool:
    return value is not None and value <= as_of


def _repeat_creation_metric(*, as_of) -> dict:
    cohort_start = as_of - timedelta(days=120)
    cohort_end = as_of - timedelta(days=60)
    by_organizer = defaultdict(list)
    creation_rows = (
        Event.objects.filter(
            organizer__is_staff=False,
            organizer__is_superuser=False,
            created_at__lte=as_of,
        )
        .order_by("organizer_id", "created_at")
        .values_list("organizer_id", "created_at")
    )
    for organizer_id, created_at in creation_rows:
        by_organizer[organizer_id].append(created_at)

    eligible_total = 0
    repeated_total = 0
    for creation_times in by_organizer.values():
        first_created_at = creation_times[0]
        if not cohort_start <= first_created_at <= cohort_end:
            continue
        eligible_total += 1
        if len(creation_times) > 1 and creation_times[1] <= first_created_at + timedelta(days=60):
            repeated_total += 1
    return {
        **_rate(repeated_total, eligible_total),
        "cohortStart": cohort_start.isoformat(),
        "cohortEnd": cohort_end.isoformat(),
    }


def build_product_metrics(*, as_of=None, window_days: int = 30) -> dict:
    as_of = as_of or timezone.now()
    period_start = as_of - timedelta(days=window_days)
    production_events = Event.objects.filter(
        organizer__is_staff=False,
        organizer__is_superuser=False,
    )
    event_cohort = list(
        production_events.filter(
            created_at__gte=period_start,
            created_at__lte=as_of,
        )
        .select_related("final_meeting")
        .prefetch_related("invitations")
    )

    activated_events = 0
    invitation_durations = []
    response_eligible_events = []
    finalized_response_eligible_events = 0
    closed_events = 0
    for event in event_cohort:
        sent_times = [
            invitation.first_sent_at
            for invitation in event.invitations.all()
            if _occurred_by(invitation.first_sent_at, as_of)
        ]
        if sent_times:
            activated_events += 1
            invitation_durations.append((event.created_at, min(sent_times)))
        if len(classify_event_responses(event)["counted"]) >= 2:
            response_eligible_events.append(event)
            final_meeting = getattr(event, "final_meeting", None)
            if final_meeting is not None and _occurred_by(final_meeting.confirmed_at, as_of):
                finalized_response_eligible_events += 1
        if _occurred_by(event.closed_at, as_of):
            closed_events += 1

    sent_invitations = list(
        EventInvitation.objects.filter(
            event__organizer__is_staff=False,
            event__organizer__is_superuser=False,
            first_sent_at__gte=period_start,
            first_sent_at__lte=as_of,
        )
    )
    submitted_invitations = sum(
        _occurred_by(invitation.submitted_at, as_of) for invitation in sent_invitations
    )
    participant_cohort = list(
        Participant.objects.filter(
            event__organizer__is_staff=False,
            event__organizer__is_superuser=False,
            created_at__gte=period_start,
            created_at__lte=as_of,
        )
    )
    email_jobs = EmailDeliveryJob.objects.filter(
        created_at__gte=period_start,
        created_at__lte=as_of,
    ).filter(
        Q(event__organizer__is_staff=False, event__organizer__is_superuser=False)
        | Q(member__is_staff=False, member__is_superuser=False)
    )
    attempted_email_jobs = email_jobs.filter(attempt_count__gt=0).count()
    retried_email_jobs = email_jobs.filter(attempt_count__gt=1).count()
    permanent_email_failures = email_jobs.filter(
        status=EmailDeliveryJob.Status.PERMANENT_FAILURE
    ).count()
    feedback_submissions = (
        FeedbackSubmission.objects.filter(
            created_at__gte=period_start,
            created_at__lte=as_of,
        )
        .filter(Q(member__isnull=True) | Q(member__is_staff=False, member__is_superuser=False))
        .count()
    )

    return {
        "schemaVersion": 1,
        "generatedAt": as_of.isoformat(),
        "period": {
            "start": period_start.isoformat(),
            "end": as_of.isoformat(),
            "windowDays": window_days,
        },
        "events": {
            "created": len(event_cohort),
            "invitationActivation": _rate(activated_events, len(event_cohort)),
            "eligibleForFinalization": len(response_eligible_events),
            "finalization": _rate(
                finalized_response_eligible_events,
                len(response_eligible_events),
            ),
            "closure": _rate(closed_events, len(event_cohort)),
            "creationToFirstInvitation": _median_duration(invitation_durations),
            "withoutInvitation": len(event_cohort) - activated_events,
        },
        "invitations": {
            "sent": len(sent_invitations),
            "opened": sum(
                _occurred_by(invitation.opened_at, as_of) for invitation in sent_invitations
            ),
            "joined": sum(
                _occurred_by(invitation.joined_at, as_of) for invitation in sent_invitations
            ),
            "draftSaved": sum(
                _occurred_by(invitation.draft_saved_at, as_of) for invitation in sent_invitations
            ),
            "validSubmission": submitted_invitations,
            "submissionConversion": _rate(submitted_invitations, len(sent_invitations)),
            "openedNotJoined": sum(
                _occurred_by(invitation.opened_at, as_of)
                and not _occurred_by(invitation.joined_at, as_of)
                for invitation in sent_invitations
            ),
            "joinedNotDraftSaved": sum(
                _occurred_by(invitation.joined_at, as_of)
                and not _occurred_by(invitation.draft_saved_at, as_of)
                and not _occurred_by(invitation.submitted_at, as_of)
                for invitation in sent_invitations
            ),
            "draftSavedNotSubmitted": sum(
                _occurred_by(invitation.draft_saved_at, as_of)
                and not _occurred_by(invitation.submitted_at, as_of)
                for invitation in sent_invitations
            ),
            "joinToSubmission": _median_duration(
                (
                    invitation.joined_at,
                    invitation.submitted_at
                    if _occurred_by(invitation.submitted_at, as_of)
                    else None,
                )
                for invitation in sent_invitations
            ),
        },
        "participants": {
            "joined": len(participant_cohort),
            "validSubmission": sum(
                _occurred_by(participant.first_submitted_at, as_of)
                for participant in participant_cohort
            ),
            "draftSavedNotSubmitted": sum(
                _occurred_by(participant.first_draft_saved_at, as_of)
                and not _occurred_by(participant.first_submitted_at, as_of)
                for participant in participant_cohort
            ),
            "completion": _median_duration(
                (
                    participant.created_at,
                    participant.first_submitted_at
                    if _occurred_by(participant.first_submitted_at, as_of)
                    else None,
                )
                for participant in participant_cohort
            ),
        },
        "organizers": {
            "repeatCreationWithin60Days": _repeat_creation_metric(as_of=as_of),
        },
        "delivery": {
            "jobs": email_jobs.count(),
            "attempted": attempted_email_jobs,
            "retried": retried_email_jobs,
            "retryRate": _rate(retried_email_jobs, attempted_email_jobs),
            "permanentFailures": permanent_email_failures,
            "permanentFailureRate": _rate(
                permanent_email_failures,
                attempted_email_jobs,
            ),
        },
        "feedback": {
            "submitted": feedback_submissions,
        },
    }


def prometheus_product_metrics(metrics: dict) -> str:
    metric_values = [
        (
            "releviz_events_created",
            "Events created in the reporting window.",
            metrics["events"]["created"],
        ),
        (
            "releviz_event_invitation_activation_ratio",
            "Share of created events with at least one delivered invitation.",
            metrics["events"]["invitationActivation"]["value"],
        ),
        (
            "releviz_invitation_submission_conversion_ratio",
            "Share of delivered invitations that reached a valid submission.",
            metrics["invitations"]["submissionConversion"]["value"],
        ),
        (
            "releviz_event_finalization_ratio",
            "Share of eligible events that confirmed a final time.",
            metrics["events"]["finalization"]["value"],
        ),
        (
            "releviz_organizer_repeat_creation_60d_ratio",
            "Share of eligible organizers who created a second event within 60 days.",
            metrics["organizers"]["repeatCreationWithin60Days"]["value"],
        ),
        (
            "releviz_email_retry_ratio",
            "Share of attempted delivery jobs that required another attempt.",
            metrics["delivery"]["retryRate"]["value"],
        ),
        (
            "releviz_email_permanent_failures",
            "Email delivery jobs in permanent failure during the reporting window.",
            metrics["delivery"]["permanentFailures"],
        ),
        (
            "releviz_feedback_submissions",
            "Feedback submissions received during the reporting window.",
            metrics["feedback"]["submitted"],
        ),
    ]
    lines = []
    for name, help_text, value in metric_values:
        lines.extend(
            [
                f"# HELP {name} {help_text}",
                f"# TYPE {name} gauge",
                f"{name} {'NaN' if value is None else value}",
            ]
        )
    return "\n".join(lines) + "\n"
