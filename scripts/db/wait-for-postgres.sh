#!/usr/bin/env bash
set -euo pipefail

host="${DB_HOST:-127.0.0.1}"
port="${DB_PORT:-5433}"
name="${DB_NAME:-releviz_test}"
user="${DB_USER:-releviz}"
password="${DB_PASSWORD:-releviz}"
deadline=$((SECONDS + 60))
successes=0

until python3 - <<PY >/dev/null 2>&1
import psycopg

with psycopg.connect(
    host="${host}",
    port=int("${port}"),
    dbname="${name}",
    user="${user}",
    password="${password}",
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
  python3 - <<PY
import psycopg

with psycopg.connect(
    host="${host}",
    port=int("${port}"),
    dbname="${name}",
    user="${user}",
    password="${password}",
    connect_timeout=1,
) as conn:
    with conn.cursor() as cur:
        cur.execute("select 1")
        cur.fetchone()
PY
  successes=$((successes + 1))
  sleep 1
done
