#!/usr/bin/env bash
set -euo pipefail

echo "=== Backend: lint ==="
npm --workspace=releviz-api run lint

echo "=== Backend: format check ==="
npm --workspace=releviz-api run format:check

echo "=== Backend: 100% coverage ==="
npm --workspace=releviz-api run test:coverage

echo "=== Frontend: lint ==="
npm --workspace=releviz-web run lint

echo "=== Frontend: format check ==="
npm --workspace=releviz-web run format:check

echo "=== Frontend: core-inclusive coverage ==="
npm --workspace=releviz-web run test:coverage

echo "=== Frontend: build ==="
npm --workspace=releviz-web run build

echo "=== Frontend: Amplify static export ==="
npm --workspace=releviz-web run build:amplify
python3 scripts/ci/validate_amplify_static_export.py \
  --out src/web/out \
  --manifest src/web/amplify-routes.json

echo "=== Repository: resource audit ==="
npm run test:audit

echo "=== Backend: Postgres integration ==="
npm run test:db

echo "=== Browser: Playwright E2E ==="
npm run test:e2e

echo "=== Quality gate passed ==="
