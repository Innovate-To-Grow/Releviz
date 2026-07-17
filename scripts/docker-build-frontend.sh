#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image_tag="${1:-scheduler-frontend:local}"
if [ "$#" -gt 0 ]; then
  shift
fi

docker build -t "$image_tag" "$@" "$root_dir/frontend"
