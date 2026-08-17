#!/usr/bin/env bash
set -euo pipefail

export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-5433}"
export DB_NAME="${DB_NAME:-releviz_test}"
export DB_USER="${DB_USER:-releviz}"
export DB_PASSWORD="${DB_PASSWORD:-releviz}"
export DB_TEST_NAME="${DB_TEST_NAME:-releviz_test}"
export DJANGO_SETTINGS_MODULE=config.settings.e2e
export BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:4100}"
export FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:3100}"
export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-${BACKEND_URL}}"
export EMAIL_FILE_PATH="${EMAIL_FILE_PATH:-/tmp/releviz-e2e-mail}"
export DJANGO_SUPERUSER_EMAIL="${DJANGO_SUPERUSER_EMAIL:-admin@releviz.local}"
if [ -z "${DJANGO_SUPERUSER_PASSWORD:-}" ]; then
  DJANGO_SUPERUSER_PASSWORD="E2E-Aa1!$(openssl rand -hex 24)"
fi
export DJANGO_SUPERUSER_PASSWORD

rm -rf "${EMAIL_FILE_PATH}"
mkdir -p "${EMAIL_FILE_PATH}"

if [ "${E2E_SKIP_DOCKER:-0}" != "1" ]; then
  docker compose -f docker-compose.e2e.yml up -d postgres
  trap 'docker compose -f docker-compose.e2e.yml down -v' EXIT
fi

scripts/db/wait-for-postgres.sh
python3 src/api/manage.py migrate --noinput --settings=config.settings.e2e
python3 src/api/manage.py seed_admin_e2e \
  --yes \
  --email "${DJANGO_SUPERUSER_EMAIL}" \
  --password "${DJANGO_SUPERUSER_PASSWORD}" \
  --settings=config.settings.e2e
npm --workspace=releviz-web run build
npm exec --workspace=releviz-web -- playwright test --config=../e2e/playwright.config.js
