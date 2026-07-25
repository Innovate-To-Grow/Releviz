#!/usr/bin/env bash
set -euo pipefail

echo "=== Backend: lint ==="
npm --workspace=releviz-backend run lint

echo "=== Backend: format check ==="
npm --workspace=releviz-backend run format:check

echo "=== Backend: 100% coverage ==="
npm --workspace=releviz-backend run test:coverage

echo "=== Frontend: lint ==="
npm --workspace=releviz-frontend run lint

echo "=== Frontend: format check ==="
npm --workspace=releviz-frontend run format:check

echo "=== Frontend: core-inclusive coverage ==="
npm --workspace=releviz-frontend run test:coverage

echo "=== Frontend: build ==="
npm --workspace=releviz-frontend run build

echo "=== Repository: resource audit ==="
npm run test:audit

echo "=== Backend: Postgres integration ==="
npm run test:db

echo "=== Browser: Playwright E2E ==="
npm run test:e2e

echo "=== Quality gate passed ==="
