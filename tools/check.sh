#!/bin/bash
# Every offline check. Exit non-zero on the first failure. Tasks 4, 8 and 9 add their checks below.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PY:-python}
"$PY" -I tools/check_catalog.py
node tools/check_store.mjs
node tools/check_tools.mjs
J=$(ls -d /e/Android/jdk-17*/bin | head -1); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
"$J/javac" --release 11 -d "$T" src/local/adam/tvtoolbox/AdbCommands.java tools/CheckAdb.java
"$J/java" -cp "$T" local.adam.tvtoolbox.CheckAdb
