#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_bin="${PYTHON_BIN:-$root_dir/.venv/bin/python}"
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5433}"
export PGUSER="${PGUSER:-releviz}"
export PGPASSWORD="${PGPASSWORD:-releviz}"
export PGDATABASE="${PGDATABASE:-releviz_test}"
export DB_HOST="$PGHOST"
export DB_PORT="$PGPORT"
export DB_USER="$PGUSER"
export DB_PASSWORD="$PGPASSWORD"
export DB_NAME="$PGDATABASE"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
artifact_dir="${DRILL_ARTIFACT_DIR:-$root_dir/.artifacts/backup-restore/$timestamp}"
restore_database="${RESTORE_DATABASE:-releviz_restore_drill_$$}"
backup_path="$artifact_dir/releviz.dump"
source_manifest="$artifact_dir/source-manifest.json"
restored_manifest="$artifact_dir/restored-manifest.json"
evidence_path="$artifact_dir/evidence.json"

if [ "$restore_database" = "$PGDATABASE" ]; then
  echo "RESTORE_DATABASE must differ from PGDATABASE." >&2
  exit 2
fi

mkdir -p "$artifact_dir"

cleanup() {
  if [ "${KEEP_RESTORE_DATABASE:-0}" != "1" ]; then
    PGDATABASE=postgres dropdb --if-exists --force "$restore_database" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

(
  cd "$root_dir"
  "$python_bin" src/api/manage.py database_manifest \
    --settings=config.settings.e2e >"$source_manifest"
)

"$root_dir/scripts/db/postgres-backup.sh" "$backup_path"

ALLOW_DATABASE_RESTORE=1 \
  RESTORE_DATABASE="$restore_database" \
  "$root_dir/scripts/db/postgres-restore.sh" "$backup_path"

(
  cd "$root_dir"
  DB_NAME="$restore_database" "$python_bin" src/api/manage.py database_manifest \
    --settings=config.settings.e2e >"$restored_manifest"
  DB_NAME="$restore_database" "$python_bin" src/api/manage.py migrate \
    --check \
    --settings=config.settings.e2e
  DB_NAME="$restore_database" "$python_bin" src/api/manage.py check \
    --settings=config.settings.e2e
)

cmp "$source_manifest" "$restored_manifest"

"$python_bin" - "$source_manifest" "$backup_path" "$restore_database" "$evidence_path" <<'PY'
import hashlib
import json
import pathlib
import sys
from datetime import UTC, datetime

manifest_path, backup_path, restore_database, evidence_path = map(pathlib.Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
backup_digest = hashlib.sha256(backup_path.read_bytes()).hexdigest()
evidence = {
    "schemaVersion": 1,
    "completedAt": datetime.now(UTC).isoformat(),
    "status": "passed",
    "restoreDatabase": restore_database.name,
    "backupFile": backup_path.name,
    "backupSha256": backup_digest,
    "tableCount": manifest["tableCount"],
    "databaseManifestSha256": manifest["overallSha256"],
    "checks": {
        "checksumVerified": True,
        "exactTableManifestMatched": True,
        "djangoMigrationsCurrent": True,
        "djangoSystemCheckPassed": True,
    },
}
pathlib.Path(evidence_path).write_text(
    json.dumps(evidence, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

echo "Backup/restore drill passed."
echo "Evidence: $evidence_path"
