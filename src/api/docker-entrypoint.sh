#!/bin/sh
set -eu

if [ "${DJANGO_MIGRATE_ON_START:-0}" = "1" ]; then
  python manage.py migrate_locked --noinput
elif [ "${DJANGO_SKIP_STARTUP_TASKS:-0}" != "1" ]; then
  python manage.py migrate_locked --noinput
  python manage.py collectstatic --noinput

  if [ "${DJANGO_CREATE_DEFAULT_ADMIN:-0}" = "1" ]; then
    python manage.py ensure_default_admin --yes
  fi
fi

exec "$@"
