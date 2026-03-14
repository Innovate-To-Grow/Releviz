#!/usr/bin/env bash
set -euo pipefail

echo "=== Backend: lint ==="
npm --workspace=backend run lint

echo "=== Backend: test ==="
npm --workspace=backend run test

echo "=== Frontend: lint ==="
npm --workspace=frontend run lint

echo "=== Frontend: test ==="
npm --workspace=frontend run test

echo "=== Frontend: build ==="
npm --workspace=frontend run build

echo "=== Quality gate passed ==="
