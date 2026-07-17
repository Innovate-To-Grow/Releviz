# Production Deployment and Rollback

## Safety Model

Production ECS keeps 100% healthy capacity during a rollout, allows 200% temporary capacity, grants
new tasks a 120-second health-check grace period, and enables the ECS deployment circuit breaker
with automatic rollback. The ALB uses the database-aware `/api/health` endpoint. Container startup
uses `migrate_safely`, which serializes PostgreSQL migrations with an advisory lock before starting
Gunicorn.

RDS retains 30 days of automated backups and a final snapshot. Take and validate a logical backup
before a migration release with meaningful data-shape risk.

## One-time Production Setup

1. Create the Django secret key, field-encryption key, and metrics bearer token in AWS Secrets
   Manager. Create a monitored SNS topic and verify a real subscriber receives a test notification.
2. Run `infra/bootstrap` once with an administrator, supplying a globally unique
   `state_bucket_name`, `production_route53_zone_id`, and the three `production_secret_arns`.
   Configure its `production_deploy_role_arn` output as `AWS_PROD_ROLE_ARN` in the GitHub
   `Production` Environment and its bucket output as `PROD_TF_STATE_BUCKET`.
3. Configure every production variable listed in the README. Restrict the `Production` Environment
   to `main` and require a reviewer. Production has no static AWS-key fallback.
4. Deploy first to a non-conflicting hostname such as `production.releviz.com`. Staging currently
   manages `releviz.com`; never let two Terraform states manage the same Route53 record. Move
   staging to its permanent hostname, verify production, then perform the apex cutover in a
   separately reviewed change.
5. Confirm AWS account quotas cover two NAT gateways, the ALB, Multi-AZ RDS, and at least four
   steady-state Fargate tasks. Record owners for DNS, SNS/on-call, RDS restore, and release approval.

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

Start **Deploy Production** from the `main` branch, enter `DEPLOY`, and approve the protected
`Production` Environment after confirming the selected commit passed `CI Result`. The workflow
builds separate immutable backend/frontend images, saves a Terraform plan, applies that exact plan,
waits for both ECS services, and runs smoke tests.

For an operator-reviewed local plan, use the protected remote backend and the same environment
variables as the workflow:

```bash
terraform -chdir=infra/prod fmt -check
terraform -chdir=infra/prod init
terraform -chdir=infra/prod validate
terraform -chdir=infra/prod test
terraform -chdir=infra/prod plan -out=production.tfplan
terraform -chdir=infra/prod apply production.tfplan
```

Terraform updates separate task definitions and ECS services. For an already registered backend
task definition, the guarded rollout helper can perform and record the service transition:

```bash
ALLOW_ECS_DEPLOY=1 \
AWS_REGION=us-west-2 \
ECS_CLUSTER=scheduler-prod-cluster \
ECS_SERVICE=scheduler-prod-backend-service \
scripts/ecs-service-rollout.sh deploy scheduler-prod-backend-task:<revision>
```

Use `scheduler-prod-frontend-service` and `scheduler-prod-frontend-task:<revision>` for an
independent frontend-only transition.

The helper resolves an active task-definition ARN, enforces the circuit-breaker and healthy-capacity
configuration, waits for service stability, verifies the primary rollout completed with the desired
running count, and writes before/update/after JSON plus privacy-safe evidence under
`.artifacts/ecs-rollouts/`.

## Post-deployment Verification

```bash
curl --fail https://releviz.com/api/health/live
curl --fail https://releviz.com/api/health
curl --fail \
  -H "Authorization: Bearer $METRICS_BEARER_TOKEN" \
  https://releviz.com/api/metrics
```

Then complete one isolated organizer/participant smoke workflow, verify an email job reaches the
expected test backend/provider state, inspect task exits and target health, and watch target-5xx,
request-exception, running-task, and permanent-email-failure alarms through the rollback window.

## Roll Back Application Code

Use the exact current ARN as a race guard and an explicitly selected previous active revision:

```bash
ALLOW_ECS_ROLLBACK=1 \
EXPECTED_CURRENT_TASK_DEFINITION=arn:aws:ecs:us-west-2:<account>:task-definition/scheduler-prod-backend-task:<bad> \
AWS_REGION=us-west-2 \
ECS_CLUSTER=scheduler-prod-cluster \
ECS_SERVICE=scheduler-prod-backend-service \
scripts/ecs-service-rollout.sh rollback scheduler-prod-backend-task:<previous>
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

On 2026-07-17:

- Terraform 1.15.8 bootstrap, staging, and production format/validation plus both mocked plans passed
- mocked assertions verified Multi-AZ private RDS, managed credentials, 30-day backup retention,
  retained automated/final backups, private redundant services, autoscaling, 100/200 rollout
  capacity, circuit-breaker rollback, immutable split images, monitored SNS actions, target-5xx
  monitoring, request-exception monitoring, and permanent-email-failure monitoring
- the deployment contract test verified both environments supply every setting required by Django
  production settings and that production remains main-only, manual, OIDC-authenticated, and
  remote-state-only
- the guarded ECS helper completed simulated deploy and rollback runs against a deterministic fake
  AWS CLI and produced passing evidence

A real AWS rollout, alarm notification, RDS snapshot/PITR drill, and rollback remain target-account
operations because this workspace has no production credentials. Record those results before live
traffic.
