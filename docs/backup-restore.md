# PostgreSQL Backup and Restore

## Recovery Layers

Production Terraform configures encrypted RDS storage, deletion protection, final snapshots,
30-day automated-backup retention, retained automated backups after instance deletion, and snapshot
tag copying. Account-level RDS point-in-time restore and snapshot permissions must still be checked
in the target AWS account.

The repository also provides a portable logical backup:

- `scripts/postgres-backup.sh`
- `scripts/postgres-restore.sh`
- `scripts/backup-restore-drill.sh`
- `python backend/src/manage.py database_manifest`

Logical archives use PostgreSQL custom format, compression, no owner/ACL metadata, restrictive
local permissions, archive validation, and a SHA-256 sidecar. The script does not upload or encrypt
the archive itself. Production archives must be transferred over an encrypted channel into an
encrypted, access-logged, versioned object store with lifecycle retention.

## Backup

```bash
PGHOST=db.example \
PGPORT=5432 \
PGDATABASE=releviz \
PGUSER=backup_operator \
PGPASSWORD="$PGPASSWORD" \
scripts/postgres-backup.sh /secure/backups/releviz-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Verify that both the dump and `.sha256` file exist, `pg_restore --list` succeeds, and the object
store reports a successful upload before considering the backup complete.

## Restore Safeguards

Restore always requires `ALLOW_DATABASE_RESTORE=1` and a named `RESTORE_DATABASE`. It validates the
checksum and archive, creates a fresh target database, and refuses to overwrite `PGDATABASE` unless
the separate `ALLOW_IN_PLACE_RESTORE=1` override is also supplied.

Use a separate target first:

```bash
PGHOST=db.example \
PGPORT=5432 \
PGDATABASE=releviz \
PGUSER=restore_operator \
PGPASSWORD="$PGPASSWORD" \
RESTORE_DATABASE=releviz_restore_validation \
ALLOW_DATABASE_RESTORE=1 \
scripts/postgres-restore.sh /secure/backups/releviz.dump
```

After restore:

```bash
DB_NAME=releviz_restore_validation \
python backend/src/manage.py migrate --check --settings=config.settings.production

DB_NAME=releviz_restore_validation \
python backend/src/manage.py check --settings=config.settings.production
```

Run application smoke tests against the restored database before any DNS or service cutover.
In-place restore is a last resort and requires a declared outage, a fresh backup of the current
database, confirmation of the target identifier, and two-person review.

## Executable Drill

Against the isolated PostgreSQL test service:

```bash
PATH="$PWD/.venv/bin:$PATH" scripts/backup-restore-drill.sh
```

The drill:

1. creates a privacy-safe exact table/count/hash manifest
2. creates and validates a logical archive and checksum
3. restores into a fresh temporary database
4. checks migrations and Django configuration
5. compares every table's deterministic row digest
6. writes `evidence.json`
7. removes the temporary database by default

The manifest command sorts and hashes row JSON and can be expensive; use it for controlled recovery
drills, not for monitoring or frequent production scrapes.

## Verified Drill Evidence

The 2026-07-16 isolated PostgreSQL drill passed:

- archive size: 256,075 bytes
- archive SHA-256: `1b402e697f46d41c571d9f4679336c6e83e04075bc93a04c1a5266fe3e4d5706`
- table count: 33
- source/restored manifest file SHA-256:
  `42650e35417420b2700460ae1aa8063e5af89110b7150a7892e653873cf4785a`
- database manifest SHA-256:
  `0a4db1c6f0c82976f46147f56f9138857bc0369e8969842b4817d90d8997f110`
- checksum, exact manifest comparison, migration check, and Django system check: passed
- temporary restore database removal: verified

The ignored local artifact is under
`.artifacts/backup-restore/20260716T201425Z/`. It is validation data, not a production backup.

## Recovery Objectives

Planning assumptions for the initial small deployment are:

- target RPO: no more than 24 hours from daily logical backups; prefer the newest available RDS
  point-in-time restore point for a smaller loss window
- target RTO: 60 minutes for a small database, including restore, migration/configuration checks,
  smoke testing, and service cutover

These are operational targets, not measured production results. Measure and revise them with a
representative encrypted RDS snapshot/PITR drill before launch, then repeat at least quarterly and
after material schema or infrastructure changes.
