# Production bootstrap

The GitHub production role deliberately cannot create, tag, or delete Amplify
apps and branches. Provision those resources once with administrator
credentials, then bind the role to the resulting exact app ID.

## Initial Amplify provisioning

1. With administrator credentials for the production account, run:

   ```bash
   export EXPECTED_AWS_ACCOUNT_ID="<12-digit-production-account-id>"
   amplify_app_id="$(infra/bootstrap/provision-amplify.sh)"
   ```

   The script creates or verifies `releviz-prod-frontend` and its `candidate`
   and `main` branches. Before any Amplify read or write, it verifies the active
   administrator identity with AWS STS and refuses an account other than
   `EXPECTED_AWS_ACCOUNT_ID`. It also refuses ambiguous names, unexpected
   stages, or resources without the `Project=releviz`, `Environment=prod`, and
   `ManagedBy=terraform` ownership tags. It never deletes or retags resources.

2. Re-apply this bootstrap state with the exact ID:

   ```bash
   terraform -chdir=infra/bootstrap apply \
     -var-file=production.tfvars \
     -var="production_amplify_app_id=${amplify_app_id}"
   ```

3. Store the same value as the protected GitHub Production environment variable
   `PROD_AMPLIFY_APP_ID`. Production Terraform consumes it as
   `TF_VAR_amplify_app_id`.

The `infra/prod` import blocks then adopt the app and both branches on the first
production plan. Leaving `production_amplify_app_id` empty is safe before
provisioning because it grants the GitHub role no Amplify API permissions, but
the production workflow must not run in that state.

After the exact ID is configured, the GitHub role can refresh and update only
that app, its `candidate` and `main` branches, their deployment jobs, and the
canonical domain association. It has no Amplify `CreateApp`, `CreateBranch`,
`TagResource`, `UntagResource`, or delete actions.
