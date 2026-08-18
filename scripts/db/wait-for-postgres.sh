#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python_bin="${PYTHON_BIN:-${repository_root}/src/api/.venv/bin/python}"
if ! command -v "$python_bin" >/dev/null 2>&1; then
  echo "Backend Python environment is missing; run npm run setup:api or set PYTHON_BIN." >&2
  exit 2
fi

host="${DB_HOST:-127.0.0.1}"
port="${DB_PORT:-5433}"
name="${DB_NAME:-releviz_test}"
user="${DB_USER:-releviz}"
password="${DB_PASSWORD:-releviz}"
deadline=$((SECONDS + 60))
successes=0
export RELEVIZ_WAIT_DB_HOST="$host"
export RELEVIZ_WAIT_DB_PORT="$port"
export RELEVIZ_WAIT_DB_NAME="$name"
export RELEVIZ_WAIT_DB_USER="$user"
export RELEVIZ_WAIT_DB_PASSWORD="$password"

until "$python_bin" - <<'PY' >/dev/null 2>&1
import os

import psycopg

with psycopg.connect(
    host=os.environ["RELEVIZ_WAIT_DB_HOST"],
    port=int(os.environ["RELEVIZ_WAIT_DB_PORT"]),
    dbname=os.environ["RELEVIZ_WAIT_DB_NAME"],
    user=os.environ["RELEVIZ_WAIT_DB_USER"],
    password=os.environ["RELEVIZ_WAIT_DB_PASSWORD"],
    connect_timeout=1,
) as conn:
    with conn.cursor() as cur:
        cur.execute("select 1")
        cur.fetchone()
PY
do
  if [ "${SECONDS}" -ge "${deadline}" ]; then
    echo "Timed out waiting for Postgres at ${host}:${port}" >&2
    exit 1
  fi
  successes=0
  sleep 1
done

while [ "${successes}" -lt 2 ]; do
  "$python_bin" - <<'PY'
import os

import psycopg

with psycopg.connect(
    host=os.environ["RELEVIZ_WAIT_DB_HOST"],
    port=int(os.environ["RELEVIZ_WAIT_DB_PORT"]),
    dbname=os.environ["RELEVIZ_WAIT_DB_NAME"],
    user=os.environ["RELEVIZ_WAIT_DB_USER"],
    password=os.environ["RELEVIZ_WAIT_DB_PASSWORD"],
    connect_timeout=1,
) as conn:
    with conn.cursor() as cur:
        cur.execute("select 1")
        cur.fetchone()
PY
  successes=$((successes + 1))
  sleep 1
done
