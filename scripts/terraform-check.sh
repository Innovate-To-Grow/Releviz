#!/usr/bin/env sh
set -eu

terraform fmt -check -recursive infra

for environment in bootstrap staging prod; do
  data_dir="${TMPDIR:-/tmp}/releviz-terraform-${environment}"
  TF_DATA_DIR="$data_dir" terraform -chdir="infra/${environment}" init \
    -backend=false \
    -input=false
  TF_DATA_DIR="$data_dir" terraform -chdir="infra/${environment}" validate
  TF_DATA_DIR="$data_dir" terraform -chdir="infra/${environment}" test
done
