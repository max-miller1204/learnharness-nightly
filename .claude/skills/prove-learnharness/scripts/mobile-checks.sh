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
# Node 22, found at run time: MOBILE_NODE_BIN if set, else whatever 22.x mise has.
NODE_BIN=$MOBILE_NODE_BIN
if [ -z "$NODE_BIN" ] && command -v mise >/dev/null 2>&1; then
	NODE_BIN=$(mise where node@22 2>/dev/null)/bin || NODE_BIN=
fi
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN/node" ] || die "BLOCKED: no Node 22 found (MOBILE_NODE_BIN unset and \`mise where node@22\` has none): install it with \`mise install node@22\`, or set MOBILE_NODE_BIN to a Node 22 bin folder"
# Absolute before any cd: a relative folder would stop matching once we're in
# apps/mobile, and PATH would fall through to whatever node comes next.
NODE_BIN=$(cd "$NODE_BIN" && pwd -P)
export PATH="$NODE_BIN:$PATH"
cd "$APP"
# The node npm and tsx will run, from inside the app folder, is the one checked.
[ "$(command -v node)" = "$NODE_BIN/node" ] || die "BLOCKED: \`node\` in apps/mobile resolves to $(command -v node), not $NODE_BIN/node"
NODE_VERSION=$(node -v)
case "$NODE_VERSION" in v22.*) ;; *) die "BLOCKED: $NODE_BIN/node is $NODE_VERSION, not Node 22 (the Mobile CI job's major)" ;; esac
say "[mobile] node $NODE_VERSION ($NODE_BIN)"
# "# pass N" / "# fail N" from node --test; a log without both is a run that never reported.
summary() { local p f; p=$(grep -E '^# pass [0-9]+$' "$1" | tail -1); f=$(grep -E '^# fail [0-9]+$' "$1" | tail -1); [ -n "$p" ] && [ -n "$f" ] && echo "$p $f"; }
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
	say "[mobile] npm ci"
	npm ci --no-audit --no-fund >"$OUT/npm-ci.log" 2>&1 || { tail -20 "$OUT/npm-ci.log" >&2; die "BLOCKED: npm ci in apps/mobile failed"; }
fi
ok=0
npm test >"$OUT/unit-tests.log" 2>&1 || ok=1
npx tsx --import ./tests/shared-modules.mjs --test "$PROVE_SCRIPTS/mobile-link-check.test.ts" >"$OUT/link-check.log" 2>&1 || ok=1
for part in unit-tests link-check; do
	s=$(summary "$OUT/$part.log") || { tail -20 "$OUT/$part.log" >&2; die "BLOCKED: $part printed no '# pass N' and '# fail N' summary (see $OUT/$part.log)"; }
	say "[mobile] $part: $s"
done
grep -E '^not ok' "$OUT/unit-tests.log" "$OUT/link-check.log" >&2 || true
exit $ok
