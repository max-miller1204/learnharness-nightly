#!/usr/bin/env bash
# health.sh <instance.env>: is this instance worth driving? Prints its identity
# (side, URL, build, data dir) and /api/health, and checks that the server on
# that port is the process this run started. Exit 0 only when usable.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
INST=${1:?usage: health.sh <instance.env>}
# shellcheck disable=SC1090
. "$INST"
SD=$(dirname "$INST")
pid_alive "$SD/app.pid" || die "$SIDE: app process from $SD/app.pid is not running"
pid_alive "$SD/fake-model.pid" || die "$SIDE: fake model from $SD/fake-model.pid is not running"
owner=$(ss -ltnpH "sport = :$APP_PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
owner_group=$( [ -n "$owner" ] && ps -o pgid= -p "$owner" | tr -d ' ')
[ "$owner_group" = "$(cat "$SD/app.pid")" ] || die "$SIDE: port $APP_PORT is owned by pid ${owner:-none} (group ${owner_group:-none}), not this run's group $(cat "$SD/app.pid")"
h=$(curl -sf "$APP_URL/api/health") || die "$SIDE: $APP_URL/api/health did not answer"
slots=$(curl -sf "$APP_URL/api/models" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log(["strong","cheap","vision"].map(k=>k+"="+(m.slots?.[k]?.model?(m.slots[k].model.provider+"/"+m.slots[k].model.id):"unset")).join(" "))})')
chats=$(curl -sf "$APP_URL/api/chats" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).chats.length))')
echo "side:     $SIDE"
echo "target:   $APP_URL (local, pid $(cat "$SD/app.pid")), fake model $FAKE_URL"
echo "build:    $BUILD_DIR ($BUILD_STAMP)"
echo "data:     $DATA_DIR ($chats chats)"
echo "slots:    $slots"
echo "health:   $h"
case "$h" in *'"ok":true'*) ;; *) die "$SIDE: health is not ok" ;; esac
case "$slots" in *unset*) die "$SIDE: a model slot is unset" ;; esac
