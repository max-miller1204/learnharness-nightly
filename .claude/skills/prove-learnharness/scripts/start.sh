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

RUN=${1:?usage: start.sh <RUN> head|base [scenario.json]}
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
	tail -40 "$SD/app.log" >&2
	die "$SIDE server not healthy within ${BOOT_TIMEOUT_S}s"
fi
# PROVE_SEED=0: a cold start with no model configured (a break-it probe).
if [ "${PROVE_SEED:-1}" = 1 ]; then
	node "$PROVE_SCRIPTS/seed.mjs" "$APP_URL" "$FAKE_URL" "$PROVE_MODEL" "$PROVE_REAL_MODEL_ID" >"$SD/seed.log" 2>&1 || { cat "$SD/seed.log" >&2; die "seeding the model failed"; }
else
	echo "not seeded (PROVE_SEED=0)" >"$SD/seed.log"
fi

STAMP=$( [ "$SIDE" = head ] && cat "$BUILD/.next/standalone/.prove-build" || cat "$BUILD/.prove-done")
cat >"$SD/instance.env" <<EOF
SIDE=$SIDE
APP_URL=$APP_URL
APP_PORT=$APP_PORT
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
echo "$SD/instance.env"
