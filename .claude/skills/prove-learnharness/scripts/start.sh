#!/usr/bin/env bash
# start.sh <RUN> head|base [scenario.json]
#
# Starts one isolated instance of an already-built side (run build.sh first):
# a fake model on a free port, then the production standalone server on
# another free port, with a throwaway HOME, data dir and auth file and no
# ambient API keys. Seeds the fake model into the model slots and writes a
# fixture file the scenarios read. Returns as soon as the instance is
# usable and prints the path of its instance.env.
#
#   RUN=$(scripts/new-run.sh teach) ; INST=$(scripts/start.sh "$RUN" head)
set -euo pipefail
. "$(dirname "$0")/lib.sh"

RUN=$(canon_run "${1:?usage: start.sh <RUN> head|base [scenario.json]}")
SIDE=${2:?usage: start.sh <RUN> head|base [scenario.json]}
SCENARIO=${3:-$PROVE_SKILL/scenarios/teach-read.json}
case "$SIDE" in
	head) BUILD=$REPO ;;
	base) BUILD=$PROVE_CACHE/base/$(base_sha); [ -f "$BUILD/.prove-done" ] || die "no base build at $BUILD; run build.sh $RUN base" ;;
	*) die "side must be head or base" ;;
esac
SERVER=$BUILD/.next/standalone/server.js
if [ "$SIDE" = base ]; then
	# A shared lock the server inherits and holds until it exits: build.sh
	# never prunes a base build that a running instance serves from.
	exec 7>"$PROVE_CACHE/base/$(base_sha).inuse"
	flock -s 7
fi
[ -f "$SERVER" ] || die "missing $SERVER; run build.sh $RUN $SIDE"

SD=$RUN/$SIDE
[ ! -f "$SD/instance.env" ] || die "$SD already has an instance; stop it first (stop.sh $RUN)"
mkdir -p "$SD/home" "$SD/data"
# The server prints a one-time pairing link (/pair#token=...) to stdout at
# boot (src/server/startup-pairing.ts), so app.log can hold a live credential.
# Blank its token in place (same length, same file, so the server's own
# writes carry on at their offsets) on every way out of this script. A start
# that fails stops its server first, so nothing prints a link afterwards.
blank_pairing() { node -e 'const fs = require("fs"); const f = process.argv[1]; if (!fs.existsSync(f)) process.exit(0); const s = fs.readFileSync(f, "latin1"); const fd = fs.openSync(f, "r+"); for (const m of s.matchAll(/#token=([^\s)]+)/g)) fs.writeSync(fd, "x".repeat(m[1].length), m.index + 7, "latin1"); fs.closeSync(fd);' "$SD/app.log"; }
STARTED=0
on_exit() {
	if [ "$STARTED" != 1 ] && [ -f "$SD/app.pid" ]; then
		kill -TERM -- "-$(cat "$SD/app.pid")" 2>/dev/null && sleep 1
	fi
	blank_pairing
}
trap on_exit EXIT
printf '{}\n' >"$SD/auth.json"
chmod 600 "$SD/auth.json"
FIXTURE=$SD/home/zz-prove-it-fixture.txt
printf 'PROVE-FIXTURE-SKY: Rayleigh scattering makes short (blue) wavelengths scatter most.\nzz-prove-it second line.\n' >"$FIXTURE"

FAKE_PORT=$(free_port)
# setsid: each process leads its own process group, so stop.sh can end it
# with every child (the standalone server forks next-server).
PROVE_FIXTURE=$FIXTURE setsid nohup node "$PROVE_SCRIPTS/fake-model.mjs" --port "$FAKE_PORT" --scenario "$SCENARIO" \
	--log "$SD/model-requests.jsonl" </dev/null >"$SD/fake-model.log" 2>&1 &
echo $! >"$SD/fake-model.pid"

APP_PORT=$(free_port)
# Login (docs/specs/login-pairing.md): a build that has the login store gets a
# session written into it, the way `lh` does; a base build from before has none.
APP_TOKEN=
if [ -f "$BUILD/selfhost/src/auth-store.ts" ]; then
	APP_TOKEN=$(node -e 'import(process.argv[1]).then((m) => console.log(m.issueSession(process.argv[2], { method: "cli", client: { label: "prove", deviceType: "bot" } }).token))' "$BUILD/selfhost/src/auth-store.ts" "$SD/data")
fi
# env -i: no ambient provider keys, tokens or LH_* settings reach the app.
# PROVE_MODEL=claude-code keeps your real HOME so the claude CLI finds its login.
APP_HOME=$SD/home
[ "$PROVE_MODEL" = claude-code ] && APP_HOME=$HOME
setsid nohup env -C "$(dirname "$SERVER")" -i PATH="$PATH:$HOME/.local/bin" HOME="$APP_HOME" LANG=C.UTF-8 \
	NODE_ENV=production HOSTNAME=127.0.0.1 PORT="$APP_PORT" NEXT_TELEMETRY_DISABLED=1 \
	LH_DATA_DIR="$SD/data" LH_AUTH_FILE="$SD/auth.json" LH_IGNORE_ENV_KEYS=1 CHROME_PATH="$PROVE_CHROME" \
	node "$SERVER" </dev/null >"$SD/app.log" 2>&1 &
echo $! >"$SD/app.pid"

APP_URL=http://127.0.0.1:$APP_PORT
FAKE_URL=http://127.0.0.1:$FAKE_PORT/v1
wait_for 10 curl -sf "http://127.0.0.1:$FAKE_PORT/__prove/state" || { cat "$SD/fake-model.log" >&2; die "fake model did not start"; }
if ! wait_for "$BOOT_TIMEOUT_S" curl -sf "$APP_URL/api/health"; then
	blank_pairing
	tail -40 "$SD/app.log" >&2
	die "$SIDE server not healthy within ${BOOT_TIMEOUT_S}s"
fi
blank_pairing
# PROVE_SEED=0: a cold start with no model configured (a break-it probe).
if [ "${PROVE_SEED:-1}" = 1 ]; then
	APP_TOKEN=$APP_TOKEN node "$PROVE_SCRIPTS/seed.mjs" "$APP_URL" "$FAKE_URL" "$PROVE_MODEL" "$PROVE_REAL_MODEL_ID" >"$SD/seed.log" 2>&1 || { cat "$SD/seed.log" >&2; die "seeding the model failed"; }
else
	echo "not seeded (PROVE_SEED=0)" >"$SD/seed.log"
fi

STAMP=$( [ "$SIDE" = head ] && cat "$BUILD/.next/standalone/.prove-build" || cat "$BUILD/.prove-done")
cat >"$SD/instance.env" <<EOF
SIDE=$SIDE
APP_URL=$APP_URL
APP_PORT=$APP_PORT
APP_TOKEN=$APP_TOKEN
FAKE_URL=$FAKE_URL
FAKE_CONTROL=http://127.0.0.1:$FAKE_PORT
BUILD_DIR=$BUILD
BUILD_STAMP="$STAMP"
HOME_DIR=$SD/home
DATA_DIR=$SD/data
AUTH_FILE=$SD/auth.json
FIXTURE=$FIXTURE
MODEL_LOG=$SD/model-requests.jsonl
APP_LOG=$SD/app.log
SCENARIO=$SCENARIO
MODEL=$PROVE_MODEL
EOF
STARTED=1
echo "$SD/instance.env"
