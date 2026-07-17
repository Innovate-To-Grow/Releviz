#!/usr/bin/env bash
set -euo pipefail

if [ "${ALLOW_DATABASE_RESTORE:-0}" != "1" ]; then
  echo "Set ALLOW_DATABASE_RESTORE=1 to authorize a database restore." >&2
  exit 2
fi

backup_path="${1:-${BACKUP_PATH:-}}"
target_database="${RESTORE_DATABASE:-}"
if [ -z "$backup_path" ] || [ -z "$target_database" ]; then
  echo "Usage: RESTORE_DATABASE=<target> ALLOW_DATABASE_RESTORE=1 postgres-restore.sh <backup.dump>" >&2
  exit 2
fi

: "${PGUSER:?PGUSER must be set.}"

source_database="${PGDATABASE:-}"
if [ "$target_database" = "$source_database" ] && [ "${ALLOW_IN_PLACE_RESTORE:-0}" != "1" ]; then
  echo "Refusing to overwrite PGDATABASE. Use a separate RESTORE_DATABASE target." >&2
  exit 2
fi

backup_path="$(realpath "$backup_path")"
backup_dir="$(dirname "$backup_path")"
backup_name="$(basename "$backup_path")"
checksum_path="${backup_path}.sha256"

if [ -f "$checksum_path" ]; then
  (
    cd "$backup_dir"
    sha256sum --check "${backup_name}.sha256"
  )
else
  echo "Backup checksum is missing: $checksum_path" >&2
  exit 2
fi

pg_restore --list "$backup_path" >/dev/null
PGDATABASE=postgres dropdb --if-exists --force "$target_database"
PGDATABASE=postgres createdb --template=template0 "$target_database"
PGDATABASE="$target_database" pg_restore \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --dbname="$target_database" \
  "$backup_path"

echo "Restore completed: $target_database"
