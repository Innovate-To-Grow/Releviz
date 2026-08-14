"""Helpers for the resetdb management command."""

import glob
import json
import os
import shutil

from django.apps import apps
from django.conf import settings

ARCHIVE_DATA_DIR = os.path.join(settings.BASE_DIR.parent, "archive", "data")


def delete_migration_files(command):
    command.stdout.write(command.style.NOTICE("Deleting migration files..."))
    deleted_count = 0
    for app_config in apps.get_app_configs():
        app_path = app_config.path
        if not app_path.startswith(str(settings.BASE_DIR)):
            continue
        migrations_dir = os.path.join(app_path, "migrations")
        if not os.path.exists(migrations_dir):
            continue
        for filename in os.listdir(migrations_dir):
            if filename in {"__init__.py", "__pycache__"}:
                continue
            file_path = os.path.join(migrations_dir, filename)
            if os.path.isfile(file_path) and filename.endswith(".py"):
                os.remove(file_path)
                command.stdout.write(f"  Deleted: {app_config.label}/migrations/{filename}")
                deleted_count += 1
        _remove_pycache(migrations_dir)
    command.stdout.write(command.style.SUCCESS(f"Deleted {deleted_count} migration file(s)."))


def reset_postgresql(connection):
    with connection.cursor() as cursor:
        cursor.execute("DROP SCHEMA public CASCADE;")
        cursor.execute("CREATE SCHEMA public;")
        cursor.execute("GRANT ALL ON SCHEMA public TO public;")
        db_user = connection.settings_dict.get("USER")
        if db_user:
            from psycopg2 import sql

            cursor.execute(
                sql.SQL("GRANT ALL ON SCHEMA public TO {user};").format(
                    user=sql.Identifier(db_user)
                )
            )


def reset_mysql(connection):
    with connection.cursor() as cursor:
        cursor.execute("SET FOREIGN_KEY_CHECKS = 0;")
        cursor.execute("SHOW TABLES;")
        for (table,) in cursor.fetchall():
            quoted_table = connection.ops.quote_name(table)
            cursor.execute(f"DROP TABLE IF EXISTS {quoted_table} CASCADE;")
        cursor.execute("SET FOREIGN_KEY_CHECKS = 1;")


def reset_sqlite(command, connection):
    db_name = connection.settings_dict["NAME"]
    if db_name == ":memory:":
        command.stdout.write("  Memory database detected.")
        drop_sqlite_tables(connection)
        return
    if os.path.exists(db_name):
        connection.close()
        try:
            os.remove(db_name)
            command.stdout.write(f"  Deleted SQLite file: {db_name}")
            return
        except OSError as exc:
            command.stdout.write(command.style.WARNING(f"  Could not delete SQLite file: {exc}"))
            drop_sqlite_tables(connection)
            return
    command.stdout.write(f"  SQLite file not found at {db_name}, nothing to delete.")


def drop_sqlite_tables(connection):
    with connection.cursor() as cursor:
        cursor.execute("PRAGMA foreign_keys = OFF;")
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
        for (table,) in cursor.fetchall():
            if table != "sqlite_sequence":
                quoted_table = connection.ops.quote_name(table)
                cursor.execute(f"DROP TABLE IF EXISTS {quoted_table};")
        cursor.execute("PRAGMA foreign_keys = ON;")


def create_default_admin(command):
    command.stdout.write(command.style.NOTICE("Creating default admin user..."))
    from apps.authn.models import ContactEmail, Member

    if not command.DEV_ADD_ADMIN_USER:
        command.stdout.write("  Skipping admin user creation (DEV_ADD_ADMIN_USER=False).")
        return
    if ContactEmail.objects.filter(email_address__iexact=command.DEV_DEFAULT_ADMIN_EMAIL).exists():
        command.stdout.write(
            f"  Admin user with email '{command.DEV_DEFAULT_ADMIN_EMAIL}' already exists."
        )
        return
    member = Member.objects.create_superuser(
        password=command.DEV_DEFAULT_ADMIN_PASSWORD,
        first_name="Dev",
        last_name="Admin",
    )
    ContactEmail.objects.create(
        member=member,
        email_address=command.DEV_DEFAULT_ADMIN_EMAIL,
        email_type="primary",
        verified=True,
    )
    command.stdout.write(command.style.SUCCESS("  Created admin user:"))
    command.stdout.write(f"    Email:    {command.DEV_DEFAULT_ADMIN_EMAIL}")
    command.stdout.write(f"    Password: {command.DEV_DEFAULT_ADMIN_PASSWORD}")
    command.stdout.write(f"    ContactEmail: {command.DEV_DEFAULT_ADMIN_EMAIL} (verified)")


def _remove_pycache(migrations_dir):
    pycache_dir = os.path.join(migrations_dir, "__pycache__")
    if os.path.exists(pycache_dir):
        shutil.rmtree(pycache_dir)


def seed_archive_data(command):
    """Seed CMS pages, menus, and footer from archive/data/."""
    if not os.path.isdir(ARCHIVE_DATA_DIR):
        command.stdout.write(
            command.style.WARNING(f"  Archive data directory not found: {ARCHIVE_DATA_DIR}")
        )
        return

    _seed_cms_pages(command)
    _seed_menus(command)
    _seed_footer(command)


def _seed_cms_pages(command):
    """Import CMS pages from the latest cms_export_*.json file."""
    matches = sorted(glob.glob(os.path.join(ARCHIVE_DATA_DIR, "cms_export_*.json")))
    if not matches:
        command.stdout.write("  No cms_export_*.json found, skipping CMS pages.")
        return

    filepath = matches[-1]  # latest by filename sort
    command.stdout.write(f"  Loading CMS pages from {os.path.basename(filepath)}...")
    with open(filepath) as f:
        bundle = json.load(f)

    pages_data = bundle.get("pages", [])
    if not pages_data:
        command.stdout.write("  No pages found in export file.")
        return

    from apps.cms.admin.cms.page_admin.import_export import process_page_data

    results = process_page_data(
        pages_data, action="execute", default_status="published", validate_required=False
    )
    created = sum(1 for r in results if r.get("success") and r.get("action") == "create")
    updated = sum(1 for r in results if r.get("success") and r.get("action") == "update")
    errors = sum(1 for r in results if r.get("errors"))
    command.stdout.write(
        command.style.SUCCESS(
            f"  CMS pages: {created} created, {updated} updated, {errors} errors."
        )
    )


def _seed_menus(command):
    """Import menus from menus.json."""
    filepath = os.path.join(ARCHIVE_DATA_DIR, "menus.json")
    if not os.path.exists(filepath):
        command.stdout.write("  No menus.json found, skipping menus.")
        return

    command.stdout.write("  Loading menus...")
    with open(filepath) as f:
        items = json.load(f)

    from apps.cms.models import Menu

    menu, created = Menu.objects.update_or_create(
        name="main_nav",
        defaults={"display_name": "Main Navigation", "items": items, "is_active": True},
    )
    action = "Created" if created else "Updated"
    command.stdout.write(
        command.style.SUCCESS(f"  {action} menu 'main_nav' with {len(items)} top-level items.")
    )


def _seed_footer(command):
    """Import footer content from footer.json."""
    filepath = os.path.join(ARCHIVE_DATA_DIR, "footer.json")
    if not os.path.exists(filepath):
        command.stdout.write("  No footer.json found, skipping footer.")
        return

    command.stdout.write("  Loading footer...")
    with open(filepath) as f:
        content = json.load(f)

    from apps.cms.models import FooterContent

    footer, created = FooterContent.objects.update_or_create(
        slug="default",
        defaults={"name": "Default Footer", "content": content, "is_active": True},
    )
    action = "Created" if created else "Updated"
    command.stdout.write(command.style.SUCCESS(f"  {action} footer 'default'."))
