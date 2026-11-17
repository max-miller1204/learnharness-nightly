#!/usr/bin/env bash
# ensure-axe.sh: install the pinned axe-core into the git-ignored
# .prove-it/tools/ (never global, never into the app's dependencies).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
T=$REPO/.prove-it/tools
if [ "$(node -p "try{require('$T/node_modules/axe-core/package.json').version}catch{''}")" != "$AXE_CORE_VERSION" ]; then
	mkdir -p "$T"
	[ -f "$T/package.json" ] || printf '{"private":true}\n' >"$T/package.json"
	npm install --prefix "$T" --no-audit --no-fund --save-exact "axe-core@$AXE_CORE_VERSION" >/dev/null
fi
echo "$T/node_modules/axe-core/axe.min.js"
