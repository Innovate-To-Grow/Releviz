#!/usr/bin/env bash
set -euo pipefail

export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-5433}"
export DB_NAME="${DB_NAME:-releviz_test}"
export DB_USER="${DB_USER:-releviz}"
export DB_PASSWORD="${DB_PASSWORD:-releviz}"
export DB_TEST_NAME="${DB_TEST_NAME:-releviz_test}"
export DJANGO_SETTINGS_MODULE=config.settings.e2e
export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-}"
export BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:4100}"
export FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:3100}"
export EMAIL_FILE_PATH="${EMAIL_FILE_PATH:-/tmp/releviz-e2e-mail}"
export DJANGO_SUPERUSER_EMAIL="${DJANGO_SUPERUSER_EMAIL:-admin@releviz.local}"
export DJANGO_SUPERUSER_PASSWORD="${DJANGO_SUPERUSER_PASSWORD:-Admin12345!}"

rm -rf "${EMAIL_FILE_PATH}"
mkdir -p "${EMAIL_FILE_PATH}"

if [ "${E2E_SKIP_DOCKER:-0}" != "1" ]; then
  docker compose -f docker-compose.e2e.yml up -d postgres
  trap 'docker compose -f docker-compose.e2e.yml down -v' EXIT
fi

scripts/wait-for-postgres.sh
python3 src/backend/manage.py migrate --noinput --settings=config.settings.e2e
python3 src/backend/manage.py ensure_default_admin --yes --settings=config.settings.e2e
npm --workspace=releviz-frontend run build
npm exec --workspace=releviz-frontend -- playwright test --config=../e2e/playwright.config.js
