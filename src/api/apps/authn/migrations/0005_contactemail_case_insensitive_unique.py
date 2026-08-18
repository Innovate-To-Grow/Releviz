from django.db import migrations, models
from django.db.models import Count
from django.db.models.functions import Lower, Trim


def normalize_contact_email_addresses(apps, schema_editor):
    ContactEmail = apps.get_model("authn", "ContactEmail")
    contacts = ContactEmail.objects.using(schema_editor.connection.alias)

    # Hold contact writes through the preflight and index creation so a new
    # case-only duplicate cannot slip in between those two operations.
    if schema_editor.connection.vendor == "postgresql":
        table_name = schema_editor.quote_name(ContactEmail._meta.db_table)
        # Bind parameters cannot represent SQL identifiers. The identifier is
        # trusted model metadata and quote_name applies backend-specific quoting.
        schema_editor.execute(  # nosemgrep: python.lang.security.audit.formatted-sql-query.formatted-sql-query,python.sqlalchemy.security.sqlalchemy-execute-raw-query.sqlalchemy-execute-raw-query
            f"LOCK TABLE {table_name} IN SHARE ROW EXCLUSIVE MODE"
        )

    normalized = Lower(Trim("email_address"))
    duplicates = (
        contacts.annotate(normalized_email=normalized)
        .values("normalized_email")
        .annotate(total=Count("pk"))
        .filter(total__gt=1)
        .order_by("normalized_email")
    )
    duplicate_count = duplicates.count()
    if duplicate_count:
        samples = list(duplicates.values_list("normalized_email", flat=True)[:10])
        suffix = (
            "" if duplicate_count <= len(samples) else f" (+{duplicate_count - len(samples)} more)"
        )
        raise RuntimeError(
            "Cannot enforce case-insensitive ContactEmail uniqueness. "
            "Resolve duplicate addresses after trimming and lowercasing, then retry the migration. "
            f"Normalized duplicates: {', '.join(repr(value) for value in samples)}{suffix}"
        )

    contacts.update(email_address=normalized)


class Migration(migrations.Migration):
    dependencies = [
        ("authn", "0004_authratelimitbucket"),
    ]

    operations = [
        migrations.RunPython(
            normalize_contact_email_addresses,
            reverse_code=migrations.RunPython.noop,
        ),
        migrations.AddConstraint(
            model_name="contactemail",
            constraint=models.UniqueConstraint(
                Lower("email_address"),
                name="unique_contact_email_ci",
            ),
        ),
    ]
