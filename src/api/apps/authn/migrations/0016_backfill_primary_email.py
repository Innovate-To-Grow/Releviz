"""Repair primary-email invariants for existing data.

A member who owns any contact email must have exactly one ``primary`` email. Two
classes of legacy inconsistency are repaired here, idempotently and without ever
transiently creating a second primary (so the partial unique constraint
``one_primary_email_per_member`` is never violated mid-migration):

* members with emails but **no** primary  -> promote one deterministically;
* members with **multiple** primaries      -> keep one, demote the rest.

Deterministic choice in both cases: prefer a verified email; among verified pick
the oldest; otherwise pick the oldest email overall. Demoted extra primaries take
the single ``secondary`` slot if free, otherwise ``other``.
"""

from django.db import migrations


def _choose(emails):
    """Pick the email to keep/promote: oldest verified, else oldest overall.

    ``emails`` is assumed pre-sorted oldest-first.
    """
    verified = [e for e in emails if e.verified]
    return verified[0] if verified else emails[0]


def forwards(apps, schema_editor):
    ContactEmail = apps.get_model("authn", "ContactEmail")

    member_ids = list(
        ContactEmail.objects.exclude(member__isnull=True).values_list("member_id", flat=True).distinct()
    )

    for member_id in member_ids:
        emails = list(ContactEmail.objects.filter(member_id=member_id).order_by("created_at", "id"))
        if not emails:
            continue

        primaries = [e for e in emails if e.email_type == "primary"]

        if len(primaries) == 1:
            continue  # already healthy

        if not primaries:
            chosen = _choose(emails)
            chosen.email_type = "primary"
            chosen.save(update_fields=["email_type", "updated_at"])
            continue

        # Multiple primaries: keep one deterministically, demote the rest. Each
        # demotion only removes a primary (never adds one), so the unique
        # constraint stays satisfied at every step.
        keep = _choose(primaries)
        has_secondary = any(e.email_type == "secondary" for e in emails)
        for email in primaries:
            if email.pk == keep.pk:
                continue
            if not has_secondary:
                email.email_type = "secondary"
                has_secondary = True
            else:
                email.email_type = "other"
            email.save(update_fields=["email_type", "updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("authn", "0015_emailauthchallenge_channel_sms"),
    ]

    operations = [
        # Reverse is a no-op: promotions/demotions are not safely reversible, and
        # reversing would re-introduce the very inconsistency this repairs.
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
