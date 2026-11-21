#!/usr/bin/env bash
# mobile-checks.sh <RUN>
#
# The scripted part of a mobile change, before the device recipe: the app's
# own unit tests (`npm test` in apps/mobile) and this skill's checks of phone
# behaviour a device run would otherwise be the only judge of
# (mobile-link-check.test.ts: the "Open in browser?" prompt's buttons). Runs
# under Node 22 (MOBILE_NODE_BIN), as the Mobile CI job does. Installs
# apps/mobile's dependencies first if they are missing or older than its
# lockfile. Logs go to <RUN>/mobile-checks/. Exit 0 all passed, 1 a check failed.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
RUN=$(canon_run "${1:?usage: mobile-checks.sh <RUN>}")
APP=$REPO/apps/mobile
OUT=$RUN/mobile-checks
mkdir -p "$OUT"
[ -x "$MOBILE_NODE_BIN/node" ] || die "BLOCKED: no Node at MOBILE_NODE_BIN=$MOBILE_NODE_BIN (set it to a Node 22 bin folder)"
export PATH="$MOBILE_NODE_BIN:$PATH"
say "[mobile] node $(node -v)"
cd "$APP"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
	say "[mobile] npm ci"
	npm ci --no-audit --no-fund >"$OUT/npm-ci.log" 2>&1 || { tail -20 "$OUT/npm-ci.log" >&2; die "BLOCKED: npm ci in apps/mobile failed"; }
fi
ok=0
npm test >"$OUT/unit-tests.log" 2>&1 || ok=1
say "[mobile] unit tests: $(grep -E '^# (pass|fail) ' "$OUT/unit-tests.log" | tr '\n' ' ')"
npx tsx --import ./tests/shared-modules.mjs --test "$PROVE_SCRIPTS/mobile-link-check.test.ts" >"$OUT/link-check.log" 2>&1 || ok=1
say "[mobile] link prompt check: $(grep -E '^# (pass|fail) ' "$OUT/link-check.log" | tr '\n' ' ')"
grep -E '^not ok' "$OUT/unit-tests.log" "$OUT/link-check.log" >&2 || true
exit $ok
