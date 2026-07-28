# Production Deployment and Rollback

## Safety Model

The production frontend is a Next.js static export hosted by AWS Amplify. The backend and Django
admin remain on private ECS Fargate tasks behind an internet-facing ALB. Amplify serves the UI and
uses external HTTPS 200 rewrites for `/api`, `/authn`, `/admin`, and `/static` to the
TLS-protected `origin.releviz.com` ALB hostname, preserving same-origin cookies and CSRF behavior.
The ALB accepts public HTTPS because AWS does not document Amplify reverse-proxy egress as coming
from a fixed source range. ECS tasks have no public IP and accept application traffic only from the
ALB security group.

The protected release workflow builds one ZIP for an exact Git SHA and deploys that same artifact
to the Amplify `candidate` branch and then the `main` branch. Each stage must return the expected
SHA from `/release.json` and pass frontend, backend-health, and admin proxy smokes before the next
stage. Amplify is a manually deployed `WEB` app; it has no repository connection, GitHub PAT, or
auto-build webhook.

The first migration leaves the existing apex ALB alias live while the Amplify app is provisioned
and tested. Before any domain association, the workflow saves the complete authoritative Route 53
apex A-alias record, including its hosted-zone target and health-evaluation setting, and verifies
that it targets the managed production ALB. Comparison accepts Route 53's optional `dualstack.`
prefix, while the saved record remains byte-for-byte structurally intact for compensation.
Terraform forgets the legacy alias state with `destroy = false`; it does not delete the live
record. Only then does the workflow create the Amplify domain association. The authoritative
cutover alias must exactly match the apex `dnsRecord` returned by Amplify; an arbitrary non-ALB
target is rejected. The ALB remains publicly reachable on HTTPS after cutover. It appends its
actual requester to the right side of `X-Forwarded-For`, and production fixes
`AUTH_TRUSTED_PROXY_COUNT=1` so the backend trusts only that one appended address. It does not trust
an earlier browser address or any CIDR-based additional hop. For Amplify-proxied requests, the
resulting safe client identity can therefore be an Amplify egress address shared by multiple users.

If a later first-cutover stage fails, the compensation handler atomically UPSERTs the saved A-alias
record and waits for the Route 53 change to reach `INSYNC`. Public ALB HTTPS ingress and fixed
one-hop proxy trust do not change during cutover, so they need no network-state compensation. The
handler intentionally retains the Amplify domain association because Terraform protects that
resource with `prevent_destroy`. A subsequent migration attempt updates the existing association
to let Amplify reconcile its Route 53 record before canonical smokes. The workflow rechecks the
saved ALB alias immediately before cutover and records the exact Amplify alias afterward;
compensation refuses to overwrite an unrecognized concurrent DNS change. At the start of every
later release, the authoritative alias must already match either that exact Amplify-reported target
or the managed ALB fallback; any third target stops the workflow before Terraform or Amplify
release mutations.

Once Amplify is the pre-release canonical target, failures preserve DNS. If a new `main` deployment
must be undone, the workflow retrieves the previous release's trusted GitHub Actions artifact,
verifies its SHA256 and embedded `/release.json`, and republishes the ZIP with Amplify
`CreateDeployment` and `StartDeployment`. It never retries completed job metadata: this manually
deployed Amplify app is not connected to a repository provider, so a completed job ID is metadata
rather than a durable rollback artifact. Later releases preserve the domain association and fixed
public-origin/one-hop topology during their first plan.
Because Amplify rewrite, header, cache, and production-branch settings are live app configuration,
the base-plan guard rejects changes to them while the canonical alias points at Amplify. Such a
change must use the documented ECS fallback so it can be applied before candidate verification
without mutating the live frontend.
If AWS contains the exact configured DomainAssociation but a killed Terraform process did not
persist it, the next deployment imports `<app-id>/<domain>` into the counted Terraform address
before planning and reconciles it rather than issuing a duplicate create.

The former ECS frontend remains running as a hot migration fallback. Production CD discovers its
currently deployed immutable image tag and supplies that same tag to Terraform; it does not build,
push, or roll that service. Remove this fallback only in a separately reviewed cleanup after the
Amplify deployment has completed its agreed soak period.

Each production run retains its Amplify ZIP and SHA256 file as a trusted GitHub Actions artifact
for 90 days. That retention is the supported frontend artifact-rollback window. After expiration,
an old Amplify job record cannot reconstruct the deployed bytes; recovery must use a separately
retained, independently trusted copy or a reviewed roll-forward/source revert that passes current
CI. Backend schema compatibility, RDS backup retention, and the ECS migration fallback have
separate windows and do not extend this 90-day artifact guarantee.

GitHub workflow concurrency prevents two normal production runs from racing, but it cannot lock an
out-of-band Amplify console or API write. Limit routine Amplify write permissions to the production
OIDC role and treat break-glass writes as an incident change. A lost runner or hard job timeout can
also prevent an `always()` compensation step from executing; in that case, use the retained
artifact from an audited operator session or the preserved ECS migration fallback.

If a private origin becomes a requirement, implement it as a separate architecture migration. The
preferred direction is self-managed CloudFront with a VPC origin and private ALB; API Gateway with
a VPC Link is another option for the dynamic routes. The current Amplify external rewrite must
remain on the documented public HTTPS boundary.

Backend ECS keeps 100% healthy capacity during a rollout, allows 200% temporary capacity, and uses
the deployment circuit breaker with automatic rollback. The workflow waits for service stability
and for every registered backend ALB target to become healthy. Container startup runs
`migrate_safely`, which serializes PostgreSQL migrations with an advisory lock before Gunicorn
starts.

RDS retains 30 days of automated backups and a final snapshot. Take and validate a logical backup
before a migration release with meaningful data-shape risk.

## One-time Production Setup

1. Create the Django secret key, field-encryption key, and metrics bearer token in AWS Secrets
   Manager. Create a monitored SNS topic and verify a real subscriber receives a test notification.
2. With administrator credentials, set
   `EXPECTED_AWS_ACCOUNT_ID="<12-digit-production-account-id>"` and run
   `infra/bootstrap/provision-amplify.sh` to create or verify the tagged
   `releviz-prod-frontend` app and its `candidate` and `main` branches. Record its exact app ID;
   before any Amplify read or write, the script verifies the active AWS STS identity and refuses
   the wrong account, ambiguous names, or incorrectly owned resources.
3. Run `infra/bootstrap` once with an administrator, supplying that
   `production_amplify_app_id`, a globally unique
   `state_bucket_name`, `production_route53_zone_id`, the three `production_secret_arns`, and the
   existing account-wide GitHub OIDC provider ARN. Run the first apply with `-backend=false`, then
   migrate local state to `bootstrap/terraform.tfstate` in the new bucket. Bootstrap never creates
   or deletes the shared OIDC provider.
4. Set the bootstrap `production_deploy_role_arn` output as `AWS_PROD_ROLE_ARN`, its bucket output
   as `PROD_TF_STATE_BUCKET`, and its exact app ID as `PROD_AMPLIFY_APP_ID` in the GitHub
   `Production` Environment. The role includes the bounded Amplify manual-deployment and
   domain-association actions used by the workflow. Existing ECS-only installations must re-apply
   `infra/bootstrap` once before their first Amplify release so the deployed role receives these
   actions.
5. Configure every production variable listed in the README. Restrict the `Production` Environment
   to `main`, require a reviewer, and do not configure static AWS keys or an Amplify repository
   access token.
6. Confirm `origin.releviz.com` is inside the selected Route53 zone. Terraform provisions its
   public ALB alias and ACM certificate. Verify public HTTPS reaches only the ALB, while backend ECS
   tasks have no public IP and allow application ingress only from the ALB security group. Do not
   create a second, manually managed origin hostname.
7. Before the first Amplify migration, verify that the existing ECS frontend task uses a
   40-character Git SHA tag in the configured `ECR_PROD_FRONTEND` repository. The migration fails
   closed if it cannot preserve this rollback target.
8. Confirm AWS quotas cover the ALB, Multi-AZ RDS, Amplify app/domain, and steady-state Fargate
   tasks. Record owners for DNS, SNS/on-call, RDS restore, and release approval.

## Migration Compatibility Window

Every backend rolling deployment must follow expand/contract:

1. Add nullable/defaulted columns, new tables, indexes, and dual-compatible behavior.
2. Deploy code that can run with both the old and expanded schema.
3. Backfill in bounded, observable batches.
4. Deploy code that no longer depends on the old representation.
5. Remove old columns or constraints only in a later release after the rollback window closes.

Do not combine a destructive schema contraction with the first code release that stops using the
old representation. A reverse Django migration is not an automatic production rollback strategy.
If a release writes data that the previous revision cannot safely interpret, roll forward or
restore a verified backup into a new database and perform a controlled cutover.

## Pre-deployment

1. Confirm the exact `main` SHA passed `CI Result`, including the Amplify static export, standard
   Next build, browser E2E, dependency audits, backend Docker scan, and Terraform tests.
2. Record the active backend task-definition ARN and image digest.
3. Record the active Amplify `main` job ID, its `/release.json` SHA, the authoritative apex A-alias
   record, and the preserved ECS frontend task-definition ARN. Identify a trusted completed
   production Actions run for the previous SHA whose artifact upload succeeded, and confirm that
   artifact is still within the 90-day retention window.
4. Review migrations with `showmigrations --plan`, run `migrate --check`, create a logical backup,
   and verify its checksum/archive listing.
5. Confirm `/api/health/live`, `/api/health`, metrics, alarms, and the email dispatcher are healthy.
6. Confirm alarm SNS actions are configured and an operator is available through the rollback
   window.

## Deploy

Run **Deploy Production** for the selected `main` commit and enter the exact confirmation `DEPLOY`.
The workflow:

1. checks out and re-verifies the exact `DEPLOY_SHA`, then requires a successful `CI Result` for
   that same SHA;
2. assumes the production AWS role through GitHub OIDC and initializes protected remote Terraform
   state;
3. discovers and freezes the existing ECS frontend rollback tag;
4. builds and pushes only the SHA-tagged backend image;
5. runs `npm ci`, creates the Amplify static export, writes `/release.json`, ZIPs the contents of
   `src/frontend/out`, verifies that its page set matches the reviewed Amplify route manifest, and
   retains the ZIP plus SHA256 file as a 90-day GitHub artifact;
6. captures the exact canonical Route 53 A alias, then applies a base Terraform plan while
   preserving the current domain association and the public-TLS-ALB/private-ECS boundary; if
   Amplify is already canonical, it rejects any plan that would change the live app, production
   branch, or domain association before candidate smoke testing;
7. waits for ECS stability and backend target health;
8. verifies that neither `candidate` nor `main` has a `CREATED`, `PENDING`, `PROVISIONING`,
   `RUNNING`, or `CANCELLING` job left by another or interrupted deployment;
9. uploads the exact ZIP with Amplify `create-deployment` and `start-deployment`, first to
   `candidate` and then to `main`, polling each job to a terminal success;
10. smoke-tests every exported clean and trailing-slash route, a deployed JavaScript asset, query
    preservation, the Amplify default URLs, protected non-GET auth routes, and an actual
    cookie/CSRF-backed Django admin POST through the candidate proxy;
11. applies the custom-domain association (or imports/reconciles an association retained in AWS
    but missing from Terraform state), waits for both domain and update readiness, verifies the
    authoritative alias exactly matches Amplify's reported apex target, and smoke-tests
    `https://releviz.com`;
12. on the first cutover, keeps public ALB HTTPS ingress and fixed one-hop proxy trust unchanged,
    and verifies canonical frontend, backend, and admin traffic;
13. verifies backend ECS remains private, waits for ECS stability and target health, and runs final
    canonical smokes;
14. if a first-cutover stage fails, atomically restores and verifies the exact saved ALB alias; on
    later releases it leaves DNS on Amplify, downloads and verifies the previous trusted 90-day
    artifact, republishes it with `CreateDeployment` and `StartDeployment`, and verifies its
    recorded SHA.

The workflow never sets a legacy DNS-management flag to false or destroys the Amplify domain
association. On the initial migration, this prevents the temporary apex-record deletion caused by
the former two-apply DNS flow. If that migration is compensated, the retained association and ALB
alias are an intentional retryable state: public ALB ingress and one-hop proxy trust remain active,
and the next deployment updates the association before cutting DNS back to Amplify. On later
releases, state and authoritative-alias detection prevent an existing association from being
destroyed during the base apply.

For local validation only:

```bash
npm ci
npm --workspace=releviz-frontend run build:amplify
python3 scripts/ci/validate_amplify_static_export.py src/frontend/out
terraform -chdir=infra/prod fmt -check
terraform -chdir=infra/prod init -backend=false
terraform -chdir=infra/prod validate
terraform -chdir=infra/prod test
```

Do not perform a local production apply or manually replace production DNS as a normal release
path.

## Post-deployment Verification

```bash
curl --fail https://releviz.com/release.json
curl --fail https://releviz.com/api/health/live
curl --fail https://releviz.com/api/health
curl --fail https://releviz.com/admin/
curl --fail \
  -H "Authorization: Bearer $METRICS_BEARER_TOKEN" \
  https://releviz.com/api/metrics
```

Confirm `/release.json` contains the selected 40-character SHA. Then complete one isolated
organizer/participant workflow, verify an email job reaches the expected provider state, inspect
Amplify and ECS health, and watch target-5xx, request-exception, running-task, and
permanent-email-failure alarms through the rollback window.

## Roll Back the Amplify Frontend

Prefer an Amplify-only rollback when the backend remains compatible. Select the exact previous SHA
and its protected production workflow run. Trust the rollback artifact only when the run belongs
to this repository and production workflow, is bound to that SHA on `main`, used a successful
`CI Result`, and produced the exact unexpired `releviz-amplify-<sha>` artifact. Download it into an
empty review directory:

```bash
gh run download <trusted-production-run-id> \
  --repo Innovate-To-Grow/releviz \
  --name releviz-amplify-<previous-sha> \
  --dir <empty-review-directory>
```

Verify both retained files before any Amplify mutation:

```bash
(
  cd <empty-review-directory>
  sha256sum --check releviz-amplify-<previous-sha>.zip.sha256
)
unzip -tq <empty-review-directory>/releviz-amplify-<previous-sha>.zip
unzip -p <empty-review-directory>/releviz-amplify-<previous-sha>.zip release.json |
  jq -e --arg sha "<previous-sha>" '.sha == $sha'
```

With incident approval, use the same verified ZIP for a candidate smoke and then for production
from an OIDC-authenticated, audited operator session:

```bash
scripts/deploy/amplify-static-deploy.sh \
  <app-id> candidate <empty-review-directory>/releviz-amplify-<previous-sha>.zip
# Verify candidate frontend, /api/health/live, /api/health, and /admin/.
scripts/deploy/amplify-static-deploy.sh \
  <app-id> main <empty-review-directory>/releviz-amplify-<previous-sha>.zip
```

The helper creates a fresh Amplify deployment and starts that uploaded deployment. Poll the new job
to terminal success, then verify canonical `/release.json`, frontend, backend health, admin, and the
affected user journey. Record the trusted Actions run, artifact digest, prior release SHA, and both
new deployment job IDs.

GitHub retains this ZIP/SHA256 pair for 90 days. Once it expires, the previous Amplify job ID is
not enough to reproduce the bytes for this repository-disconnected app. Do not rebuild an old ZIP
ad hoc or accept an artifact from an untrusted run. Use a separately retained, independently
verified copy if one exists; otherwise prepare a reviewed roll-forward or source revert, pass
current CI, and deploy it as a new release.

Do not point the apex directly back to ECS for an ordinary frontend regression. The preserved ECS
frontend is an emergency migration fallback only. Using it requires an incident-reviewed sequence:

1. verify the public TLS ALB, both ECS services, and both ALB target groups are healthy, and confirm
   the ECS tasks remain private;
2. preserve evidence for the current Amplify domain association and DNS records;
3. disassociate the Amplify custom domain and atomically UPSERT the apex alias to the recorded ALB
   DNS name and hosted-zone ID;
4. run canonical smokes against the ECS frontend;
5. create an immediate IaC repair change before any later production deployment.

Never delete the Amplify app, its branches, or the origin DNS/certificate during this fallback.

## Roll Back the Backend

Use the exact current ARN as a race guard and an explicitly selected previous active revision:

```bash
ALLOW_ECS_ROLLBACK=1 \
EXPECTED_CURRENT_TASK_DEFINITION=arn:aws:ecs:us-west-2:<account>:task-definition/releviz-prod-backend-task:<bad> \
AWS_REGION=us-west-2 \
ECS_CLUSTER=releviz-prod-cluster \
ECS_SERVICE=releviz-prod-backend-service \
scripts/ecs-service-rollout.sh rollback releviz-prod-backend-task:<previous>
```

The helper refuses rollback when the service changed after approval, the target is inactive, the
target is already active, or explicit authorization is absent. Repeat post-deployment verification
after rollback.

If database compatibility prevents code rollback:

1. stop writes or place the service in a declared maintenance state;
2. preserve the current database;
3. restore the selected backup/PITR point into a new database;
4. run migration/configuration checks and smoke tests;
5. deploy the compatible application revision against the restored database;
6. cut traffic over only after review.

Never overwrite the production database merely to make an old task revision start.
