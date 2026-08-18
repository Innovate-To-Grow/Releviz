#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
requirements_dir="${repository_root}/src/api/requirements"
uv_bin="${UV_BIN:-uv}"
uv_version="${RELEVIZ_UV_VERSION:-0.9.26}"
python_version="${RELEVIZ_PYTHON_VERSION:-3.12}"
cache_dir="${UV_CACHE_DIR:-${TMPDIR:-/tmp}/releviz-uv-cache}"
mode="${1:-write}"

case "$mode" in
  write)
    output_dir="$requirements_dir"
    ;;
  --check)
    output_dir="$(mktemp -d "${TMPDIR:-/tmp}/releviz-requirements.XXXXXX")"
    trap 'rm -rf -- "$output_dir"' EXIT
    ;;
  *)
    echo "Usage: $0 [--check]" >&2
    exit 2
    ;;
esac

if ! command -v "$uv_bin" >/dev/null 2>&1; then
  echo "uv is required to compile backend dependencies: https://docs.astral.sh/uv/" >&2
  exit 2
fi
installed_uv_version="$("$uv_bin" --version | awk '{print $2}')"
if [ "$installed_uv_version" != "$uv_version" ]; then
  echo "uv ${uv_version} is required to compile backend dependencies." >&2
  exit 2
fi

for target in base local production; do
  output_file="${output_dir}/${target}.txt"
  compile_args=(
    pip compile "${requirements_dir}/${target}.in"
    --output-file "$output_file"
    --quiet
    --universal
    --python-version "$python_version"
    --generate-hashes
    --cache-dir "$cache_dir"
    --custom-compile-command "npm run lock:api"
  )
  if [ "$mode" = "write" ]; then
    compile_args+=(--upgrade)
  else
    cp "${requirements_dir}/${target}.txt" "$output_file"
  fi
  "$uv_bin" "${compile_args[@]}"
done

if [ "$mode" = "--check" ]; then
  for target in base local production; do
    if ! diff -u \
      "${requirements_dir}/${target}.txt" \
      "${output_dir}/${target}.txt"; then
      echo "Backend dependency locks are stale; run npm run lock:api." >&2
      exit 1
    fi
  done
  echo "Backend dependency locks match their reviewed inputs."
fi
