#!/usr/bin/env bash
set -euo pipefail

umask 077

backup_path="${1:-${BACKUP_PATH:-}}"
if [ -z "$backup_path" ]; then
  echo "Usage: postgres-backup.sh <backup.dump>" >&2
  exit 2
fi

: "${PGDATABASE:?PGDATABASE must name the source database.}"
: "${PGUSER:?PGUSER must be set.}"

backup_path="$(realpath -m "$backup_path")"
backup_dir="$(dirname "$backup_path")"
backup_name="$(basename "$backup_path")"
temporary_path="${backup_path}.partial.$$"

mkdir -p "$backup_dir"
trap 'rm -f "$temporary_path"' EXIT

pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-acl \
  --file="$temporary_path" \
  "$PGDATABASE"

pg_restore --list "$temporary_path" >/dev/null
mv "$temporary_path" "$backup_path"
(
  cd "$backup_dir"
  sha256sum "$backup_name" >"${backup_name}.sha256"
)

echo "Backup created: $backup_path"
echo "Checksum created: ${backup_path}.sha256"
