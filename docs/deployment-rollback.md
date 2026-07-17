# Production Deployment and Rollback

## Safety Model

Production ECS keeps 100% healthy capacity during a rollout, allows 200% temporary capacity, grants
new tasks a 120-second health-check grace period, and enables the ECS deployment circuit breaker
with automatic rollback. The ALB uses the database-aware `/api/health` endpoint. Container startup
uses `migrate_safely`, which serializes PostgreSQL migrations with an advisory lock before starting
Gunicorn.

RDS retains 30 days of automated backups and a final snapshot. Take and validate a logical backup
before a migration release with meaningful data-shape risk.

## Migration Compatibility Window

Every rolling deployment must follow expand/contract:

1. Add nullable/defaulted columns, new tables, indexes, and dual-compatible behavior.
2. Deploy code that can run with both the old and expanded schema.
3. Backfill in bounded, observable batches.
4. Deploy code that no longer depends on the old representation.
5. Remove old columns or constraints only in a later release after the rollback window closes.

Do not combine a destructive schema contraction with the first code release that stops using the
old schema. A reverse Django migration is not an automatic production rollback strategy. If a
release writes data that the previous revision cannot safely interpret, roll forward or restore a
verified backup into a new database and perform a controlled cutover.

## Pre-deployment

1. Confirm CI, PostgreSQL integration, browser E2E, dependency audits, Docker builds, and Terraform
   tests pass for the immutable image revision.
2. Record the currently active ECS task-definition ARN and image digest.
3. Review migrations with `showmigrations --plan` and verify expand/contract compatibility.
4. Run `migrate --check`, create a logical backup, and verify its checksum/archive listing.
5. Confirm `/api/health/live`, `/api/health`, metrics, alarms, and the email dispatcher are healthy.
6. Confirm alarm SNS actions are configured and an operator is available through the rollback
   window.

## Deploy

Format, validate, test, and review production infrastructure:

```bash
terraform -chdir=infra/prod fmt -check
terraform -chdir=infra/prod init
terraform -chdir=infra/prod validate
terraform -chdir=infra/prod test
terraform -chdir=infra/prod plan -out=production.tfplan
terraform -chdir=infra/prod apply production.tfplan
```

Terraform updates the task definition and ECS service. For an already registered task definition,
the guarded rollout helper can perform and record the service transition:

```bash
ALLOW_ECS_DEPLOY=1 \
AWS_REGION=us-west-2 \
ECS_CLUSTER=scheduler-prod-cluster \
ECS_SERVICE=scheduler-prod-service \
scripts/ecs-service-rollout.sh deploy scheduler-prod-task:<revision>
```

The helper resolves an active task-definition ARN, enforces the circuit-breaker and healthy-capacity
configuration, waits for service stability, verifies the primary rollout completed with the desired
running count, and writes before/update/after JSON plus privacy-safe evidence under
`.artifacts/ecs-rollouts/`.

## Post-deployment Verification

```bash
curl --fail https://scheduler.example/api/health/live
curl --fail https://scheduler.example/api/health
curl --fail \
  -H "Authorization: Bearer $METRICS_BEARER_TOKEN" \
  https://scheduler.example/api/metrics
```

Then complete one isolated organizer/participant smoke workflow, verify an email job reaches the
expected test backend/provider state, inspect task exits and target health, and watch target-5xx,
request-exception, running-task, and permanent-email-failure alarms through the rollback window.

## Roll Back Application Code

Use the exact current ARN as a race guard and an explicitly selected previous active revision:

```bash
ALLOW_ECS_ROLLBACK=1 \
EXPECTED_CURRENT_TASK_DEFINITION=arn:aws:ecs:us-west-2:<account>:task-definition/scheduler-prod-task:<bad> \
AWS_REGION=us-west-2 \
ECS_CLUSTER=scheduler-prod-cluster \
ECS_SERVICE=scheduler-prod-service \
scripts/ecs-service-rollout.sh rollback scheduler-prod-task:<previous>
```

The script refuses rollback when the service changed after approval, the target is inactive, the
target is already active, or the explicit authorization is absent. Repeat the post-deployment
verification after rollback.

If database compatibility prevents code rollback:

1. stop writes or place the service in a declared maintenance state
2. preserve the current database
3. restore the selected backup/PITR point into a new database
4. run migration/configuration checks and smoke tests
5. deploy the compatible application revision against the restored database
6. cut traffic over only after review

Never overwrite the production database merely to make an old task revision start.

## Validation Status

On 2026-07-16:

- Terraform 1.15.8 production format, validation, and mocked plan passed
- mocked assertions verified 30-day backup retention, retained automated/final backups, 100/200
  rollout capacity, circuit-breaker rollback, target-5xx monitoring, request-exception monitoring,
  and permanent-email-failure monitoring
- the guarded ECS helper completed simulated deploy and rollback runs against a deterministic fake
  AWS CLI and produced passing evidence

A real AWS rollout, alarm notification, RDS snapshot/PITR drill, and rollback remain target-account
operations because this workspace has no production credentials. Record those results before live
traffic.
