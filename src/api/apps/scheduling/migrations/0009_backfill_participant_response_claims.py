from datetime import timedelta

from django.db import migrations
from django.db.models import DateTimeField, Exists, ExpressionWrapper, F, OuterRef, Q
from django.db.models.functions import Coalesce

# Managed add and import create the Participant and its linked invitation in the
# same transaction, so an organizer-added row has an invitation created at (or
# moments after) the row itself.
ORGANIZER_ADD_WINDOW = timedelta(minutes=10)
ENGAGED_STATUSES = ("joined", "draft_saved", "submitted")


def claim_existing_responses(apps, schema_editor):
    """Claim every full-account response except untouched organizer adds.

    Before this change the organizer could never write a full account, so any
    answer, edit record, engaged invitation or temporary session on one came from
    the person (or from a temporary-era co-edit that the upgrade ended).
    Temporary and organizer-managed rows stay NULL: the rule ignores the claim.
    """

    Participant = apps.get_model("scheduling", "Participant")
    EventInvitation = apps.get_model("scheduling", "EventInvitation")
    ScheduleEditRecord = apps.get_model("scheduling", "ScheduleEditRecord")
    TemporaryEventSession = apps.get_model("scheduling", "TemporaryEventSession")
    alias = schema_editor.connection.alias

    linked = EventInvitation.objects.using(alias).filter(
        event_id=OuterRef("event_id"), member_id=OuterRef("member_id")
    )
    # Evidence of engagement also counts email-matched invitations (member=None),
    # which only ever adds claims.
    addressed = (
        EventInvitation.objects.using(alias)
        .filter(event_id=OuterRef("event_id"))
        .filter(Q(member_id=OuterRef("member_id")) | Q(email__iexact=OuterRef("member__email")))
    )
    window_end = ExpressionWrapper(
        OuterRef("created_at") + ORGANIZER_ADD_WINDOW, output_field=DateTimeField()
    )
    untouched_organizer_adds = (
        Participant.objects.using(alias)
        .filter(
            member__access_level="full",
            organizer_managed=False,
            submitted=False,
            first_draft_saved_at__isnull=True,
            first_submitted_at__isnull=True,
        )
        .exclude(member_id=F("event__organizer_id"))
        .filter(
            Exists(
                linked.filter(created_at__gte=OuterRef("created_at"), created_at__lte=window_end)
            )
        )
        .exclude(Exists(addressed.filter(created_at__lt=OuterRef("created_at"))))
        .exclude(
            Exists(
                addressed.filter(
                    Q(accepted_at__isnull=False)
                    | Q(joined_at__isnull=False)
                    | Q(draft_saved_at__isnull=False)
                    | Q(submitted_at__isnull=False)
                    | Q(status__in=ENGAGED_STATUSES)
                )
            )
        )
        .exclude(
            Exists(ScheduleEditRecord.objects.using(alias).filter(participant_id=OuterRef("pk")))
        )
        .exclude(
            Exists(TemporaryEventSession.objects.using(alias).filter(participant_id=OuterRef("pk")))
        )
    )
    Participant.objects.using(alias).filter(
        member__access_level="full", organizer_managed=False, response_claimed_at__isnull=True
    ).exclude(pk__in=untouched_organizer_adds.values("pk")).update(
        response_claimed_at=Coalesce("first_submitted_at", "first_draft_saved_at", "created_at")
    )


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0008_participant_response_claimed_at"),
        ("authn", "0005_contactemail_case_insensitive_unique"),
    ]

    operations = [migrations.RunPython(claim_existing_responses, migrations.RunPython.noop)]
