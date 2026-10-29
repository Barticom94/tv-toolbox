#!/bin/bash
# Every offline check. Exit non-zero on the first failure. Tasks 4, 8 and 9 add their checks below.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PY:-python}
"$PY" -I tools/check_catalog.py
