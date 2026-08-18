#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_bin="${PYTHON_BIN:-python3}"
default_venv_dir="${repository_root}/src/api/.venv"
venv_dir="${RELEVIZ_API_VENV_DIR:-${default_venv_dir}}"
pip_version="${RELEVIZ_PIP_VERSION:-26.1.2}"

if ! command -v "$python_bin" >/dev/null 2>&1; then
  echo "Python 3.12 or newer is required (set PYTHON_BIN to its executable)." >&2
  exit 2
fi
if ! "$python_bin" -c \
  'import sys; raise SystemExit(0 if (3, 12) <= sys.version_info[:2] < (3, 15) else 1)'; then
  echo "Python 3.12-3.14 is required; found $($python_bin --version 2>&1)." >&2
  exit 2
fi
if [ -L "$venv_dir" ]; then
  echo "Refusing to clear a symlinked backend environment: ${venv_dir}" >&2
  exit 2
fi

canonical_venv_dir="$("$python_bin" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$venv_dir")"
canonical_default_venv_dir="$("$python_bin" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$default_venv_dir")"
canonical_system_temp="$("$python_bin" -c 'import os; print(os.path.realpath("/tmp"))')"
canonical_session_temp="$("$python_bin" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${TMPDIR:-/tmp}")"
case "$canonical_venv_dir" in
  "$canonical_default_venv_dir"|"$canonical_system_temp"/releviz-api-venv-*|"$canonical_session_temp"/releviz-api-venv-*) ;;
  *)
    echo "Refusing to clear backend environment outside src/api/.venv or a releviz-api-venv-* temp directory." >&2
    exit 2
    ;;
esac
venv_dir="$canonical_venv_dir"

"$python_bin" -m venv --clear "$venv_dir"
"${venv_dir}/bin/python" -m pip install --upgrade "pip==${pip_version}"
"${venv_dir}/bin/python" -m pip install \
  --require-hashes \
  --requirement "${repository_root}/src/api/requirements/local.txt"

echo "Backend environment ready at ${venv_dir}."
