#!/bin/sh
set -eu

if [ "${DJANGO_SKIP_STARTUP_TASKS:-0}" != "1" ]; then
  python src/manage.py migrate_safely --noinput
  python src/manage.py collectstatic --noinput

  if [ "${DJANGO_CREATE_DEFAULT_ADMIN:-0}" = "1" ]; then
    python src/manage.py ensure_default_admin --yes
  fi
fi

exec "$@"
