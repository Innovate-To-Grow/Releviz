#!/usr/bin/env bash
set -euo pipefail

export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-5433}"
export DB_NAME="${DB_NAME:-releviz_test}"
export DB_USER="${DB_USER:-releviz}"
export DB_PASSWORD="${DB_PASSWORD:-releviz}"
export DB_TEST_NAME="${DB_TEST_NAME:-test_releviz}"

if [ "${DB_TEST_SKIP_DOCKER:-0}" != "1" ]; then
  docker compose -f docker-compose.e2e.yml up -d postgres
  trap 'docker compose -f docker-compose.e2e.yml down -v' EXIT
fi

scripts/wait-for-postgres.sh
npm --workspace=releviz-backend run test:db
