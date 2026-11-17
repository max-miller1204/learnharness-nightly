#!/usr/bin/env bash
# selfhost-b.sh <RUN>
#
# Selfhost tier B (hard: update, rollback, snapshots, supervisor, protocol).
# Needs both builds (build.sh <RUN> both). Packs three archives:
#   A = the base build (version ...1), B = the head build (...2),
#   C = B with a server that exits at once (...3, a failing trial).
# Serves them from a file:// feed and drives the real launcher of the BASE
# install under its own systemd user unit, lh-prove-<hash of the run path>.service, with its
# own LH_HOME, port and bin dir:
#   1. install.sh installs A           -> healthy on A, a session created
#   2. feed -> B, lh update / --now    -> healthy on B, committed, data kept
#   3. feed -> C, lh update / --now    -> C fails its trial, rolled back to B,
#                                         C marked bad, data kept
#   4. lh rollback --yes               -> back on A, data kept
# Every switch is checked in service-state.json, /api/health, `lh status`,
# backups and the update log. Evidence in <RUN>/selfhost/. stop.sh <RUN>
# removes the unit. Your real install (~/.learnharness, learnharness.service,
# port 3774) is never read or written.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
RUN=${1:?usage: selfhost-b.sh <RUN>}
SH=$RUN/selfhost
mkdir -p "$SH/feed"
BASE_TREE=$PROVE_CACHE/base/$(base_sha)
[ -f "$BASE_TREE/.prove-done" ] || die "no base build; run build.sh $RUN both"
[ -f "$REPO/.next/standalone/.prove-build" ] || die "no head build; run build.sh $RUN both"
command -v systemctl >/dev/null || die "BLOCKED: no systemctl"
systemctl --user show-environment >/dev/null 2>&1 || die "BLOCKED: no systemd user manager"

ARCH=linux-x64
[ "$(uname -m)" = aarch64 ] && ARCH=linux-arm64
NODE_DIR=$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")
VA="$(pkg_version "$BASE_TREE")$PROVE_BASE_VERSION_SUFFIX"
VB="$(pkg_version "$REPO")$PROVE_HEAD_VERSION_SUFFIX"
VC="$(pkg_version "$REPO")$PROVE_BROKEN_VERSION_SUFFIX"
# Unique per run folder (a hash of its full path), so parallel runs never share a unit.
UNIT=lh-prove-$(printf '%s' "$RUN" | sha256sum | cut -c1-12)
echo "$UNIT" >"$SH/unit-name"   # stop.sh removes it, even if this script dies
LHH=$SH/lh-home/.learnharness
PORT=$(free_port)
export LH_HOME=$LHH LH_SERVICE_NAME=$UNIT LH_BIN_DIR=$SH/bin

# Keep the base build from being pruned while this script uses it.
exec 7>"$PROVE_CACHE/base/$(base_sha).inuse"
flock -s 7

# Isolation guard. The launchers under test decide where they write: if a
# change broke LH_HOME / LH_SERVICE_NAME / LH_BIN_DIR handling, they would fall
# back to your real ~/.learnharness, learnharness.service and ~/.local/bin/lh.
# Ask both launchers (base = A, head = B and C) where they would write, and
# refuse to start unless every path is this run's.
for tree in "$BASE_TREE" "$REPO"; do
	where=$(cd "$tree" && node --disable-warning=ExperimentalWarning --input-type=module -e "
		const p = await import('./selfhost/src/paths.ts'); const s = await import('./selfhost/src/service.ts');
		console.log([p.lhHome(), p.serviceName(), s.shimPath(), s.unitPath()].join('\n'));") \
		|| die "BLOCKED: cannot ask the $tree launcher for its paths"
	got_home=$(sed -n 1p <<<"$where"); got_name=$(sed -n 2p <<<"$where"); got_shim=$(sed -n 3p <<<"$where"); got_unit=$(sed -n 4p <<<"$where")
	[ "$got_home" = "$LHH" ] && [ "$got_name" = "$UNIT" ] && [ "$got_shim" = "$SH/bin/lh" ] && [ "$(basename "$got_unit")" = "$UNIT.service" ] \
		|| die "BLOCKED: the launcher in $tree would not stay isolated (home $got_home, unit $got_name, shim $got_shim, unit file $got_unit). Not installing."
done

# Your real install, if any: it must be byte-for-byte the same at the end.
real_fingerprint() {
	systemctl --user show -p MainPID -p ActiveState -p FragmentPath learnharness.service 2>/dev/null
	for f in "$(systemctl --user show -p FragmentPath --value learnharness.service 2>/dev/null)" "$HOME/.local/bin/lh" "$HOME/.learnharness/runtime/service-state.json"; do
		[ -n "$f" ] && [ -f "$f" ] && sha256sum "$f"
	done
	true
}
real_fingerprint >"$SH/real-install-before"
LOG=$SH/steps.log
: >"$LOG"
step() { printf '[%s] %s\n' "$1" "$2" | tee -a "$LOG"; [ "$1" = ok ] || FAILED=1; }
FAILED=0

# --- archives (A is cached beside the base build: same SHA, same bytes) ---
mkdir -p "$PROVE_CACHE/tmp"
pack() { # <tree> <version> <out dir>; staging off the small /tmp tmpfs
	(cd "$1" && TMPDIR=$PROVE_CACHE/tmp node selfhost/scripts/package-archive.ts --version "$2" --arch "$ARCH" --node-dir "$NODE_DIR" --standalone .next/standalone --out "$3") >>"$SH/pack.log" 2>&1
}
A_ARCHIVE=$BASE_TREE/.prove-archive/learnharness-$VA-$ARCH.tar.gz
# Packed once per base SHA, under the base lock, into a temp folder that is
# renamed only when complete: a half-written archive is never cached.
(
	flock 9
	if [ ! -f "$A_ARCHIVE.sha256" ]; then
		rm -rf "$BASE_TREE/.prove-archive.tmp" "$BASE_TREE/.prove-archive"
		pack "$BASE_TREE" "$VA" "$BASE_TREE/.prove-archive.tmp" && mv "$BASE_TREE/.prove-archive.tmp" "$BASE_TREE/.prove-archive"
	fi
) 9>"$PROVE_CACHE/base/$(base_sha).lock" || die "packing A failed (see $SH/pack.log)"
[ -f "$A_ARCHIVE.sha256" ] || die "packing A left no checksum (see $SH/pack.log)"
pack "$REPO" "$VB" "$SH/feed" || die "packing B failed (see $SH/pack.log)"
cp "$A_ARCHIVE" "$SH/feed/"
B_ARCHIVE=$SH/feed/learnharness-$VB-$ARCH.tar.gz
# C: B's files with a server that exits at once, so its trial must fail.
rm -rf "$SH/c-tree" && mkdir -p "$SH/c-tree"
tar -xzf "$B_ARCHIVE" -C "$SH/c-tree"
printf '%s\n' "$VC" >"$SH/c-tree/VERSION"
printf 'console.error("zz-prove-it: broken build, exiting");\nprocess.exit(3);\n' >"$SH/c-tree/server/server.js"
C_ARCHIVE=$SH/feed/learnharness-$VC-$ARCH.tar.gz
tar -czf "$C_ARCHIVE" -C "$SH/c-tree" .
rm -rf "$SH/c-tree"

feed() { # <version> <archive>: point latest.json at one archive
	local sha proto minproto
	sha=$(sha256sum "$2" | cut -d' ' -f1)
	proto=$(node --input-type=module -e "import('$REPO/selfhost/src/protocol.ts').then(m=>console.log(m.LAUNCHER_PROTOCOL))")
	minproto=$(node --input-type=module -e "import('$REPO/selfhost/src/protocol.ts').then(m=>console.log(m.MIN_LAUNCHER_PROTOCOL))")
	printf '{"version":"%s","tag":"v%s","sha":"zz-prove-it","publishedAt":"%s","launcherProtocol":%s,"minLauncherProtocol":%s,"assets":{"%s":{"url":"file://%s","sha256":"%s"}}}\n' \
		"$1" "$1" "$(date -u +%FT%TZ)" "$proto" "$minproto" "$ARCH" "$2" "$sha" >"$SH/feed/latest.json"
}

lh() { "$SH/bin/lh" "$@" </dev/null 2>&1; }
state() { node -e "const s=require('$LHH/runtime/service-state.json');console.log(JSON.stringify(s))"; }
health_version() { curl -sf "http://127.0.0.1:$PORT/api/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);console.log(h.ok?h.version:"unhealthy")})'; }
on_version() { [ "$(health_version 2>/dev/null)" = "$1" ]; }
update_status() { state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);console.log(`${x.activeVersion} ${x.update?.targetVersion??""} ${x.update?.status??""}`)})'; }
server_update_state() { curl -sf "http://127.0.0.1:$PORT/api/updates" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))'; }
seed_session() {
	curl -sf -X POST "http://127.0.0.1:$PORT/api/chats" -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" -d '{"title":"zz-prove-it selfhost data"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))'
}
has_session() { curl -sf "http://127.0.0.1:$PORT/api/chats" | grep -q "$1"; }
snap() { # <label>: evidence after a switch
	# The shim is rewritten during a switch; a failed `lh status` is evidence, not a crash.
	{ echo "== $1"; lh status || echo "(lh status exited $?)"; echo "state: $(state)"; echo "backups: $(ls "$LHH/userdata/backups" 2>/dev/null | tr '\n' ' ')"; echo; } >>"$SH/status.txt"
}

# --- 1. install A ---
feed "$VA" "$SH/feed/learnharness-$VA-$ARCH.tar.gz"
if LH_FEED_URL="file://$SH/feed/latest.json" LH_YES=1 LH_UP_ARGS="--port $PORT --no-tailscale --no-linger" sh "$BASE_TREE/selfhost/install.sh" >"$SH/install.log" 2>&1 \
	&& wait_for "$SELFHOST_SWITCH_TIMEOUT_S" on_version "$VA"; then
	step ok "install.sh installs A ($VA) under $UNIT.service on :$PORT"
else
	step FAIL "install of A: $(tail -5 "$SH/install.log" | tr '\n' ' ') health=$(health_version 2>&1)"
	exit 1
fi
SESSION=$(seed_session || true)
if [ -n "$SESSION" ]; then step ok "session $SESSION created on A"; else step FAIL "could not create a session on A (no point checking it survives)"; exit 1; fi
snap "after install A"

# --- 2. update to B (the change) ---
switching_to() { # <version>: the launcher has taken a switch to it (pending, committed or rolled back)
	node -e "const s=require('$LHH/runtime/service-state.json'); process.exit(s.update?.targetVersion==='$1' ? 0 : 1)" 2>/dev/null
}
downloaded_or_switching() { # <version>
	switching_to "$1" && return 0
	[ "$(server_update_state 2>/dev/null)" = downloaded ]
}
switch_via_server() { # <version>: check, wait for the download, install now
	# With Automatic updates on (the default) the server installs a download by
	# itself when idle, so the switch may start before `--now`: both are fine.
	lh update >>"$SH/update.log" || true
	wait_for "$SELFHOST_SWITCH_TIMEOUT_S" downloaded_or_switching "$1" || return 1
	if switching_to "$1"; then echo "(server started the switch to $1 by itself)" >>"$SH/update.log"; return 0; fi
	lh update --now >>"$SH/update.log" || true
	wait_for 60 switching_to "$1"
}
feed "$VB" "$B_ARCHIVE"
if switch_via_server "$VB" && wait_for "$SELFHOST_SWITCH_TIMEOUT_S" on_version "$VB" && wait_for 30 sh -c "[ \"\$(node -p \"require('$LHH/runtime/service-state.json').update?.status\")\" = committed ]"; then
	step ok "update A -> B: healthy on $VB, state $(update_status)"
else
	step FAIL "update A -> B: health=$(health_version 2>&1) state=$(update_status 2>&1) server=$(server_update_state 2>&1)"
fi
has_session "$SESSION" && step ok "session survives the update to B" || step FAIL "session lost after the update to B"
ls "$LHH/userdata/backups" | grep -q "$VA" && step ok "a data snapshot of A was taken before switching" || step FAIL "no backup named after $VA in $LHH/userdata/backups"
snap "after update to B"

# --- 3. a failing trial (C) rolls back to B ---
feed "$VC" "$C_ARCHIVE"
switch_via_server "$VC" || step FAIL "the switch to C never started: server=$(server_update_state 2>&1) state=$(update_status 2>&1)"
if wait_for "$SELFHOST_SWITCH_TIMEOUT_S" sh -c "node -e \"const s=require('$LHH/runtime/service-state.json'); process.exit(s.update?.targetVersion==='$VC' && s.update?.status==='rolled-back' ? 0 : 1)\"" \
	&& wait_for "$SELFHOST_SWITCH_TIMEOUT_S" on_version "$VB"; then
	step ok "failing trial C rolls back to B: state $(update_status)"
else
	step FAIL "failing trial C: health=$(health_version 2>&1) state=$(update_status 2>&1)"
fi
state | grep -q "\"badVersions\":\[[^]]*\"$VC\"" && step ok "C is marked bad so it is not retried" || step FAIL "C missing from badVersions: $(state)"
has_session "$SESSION" && step ok "session survives the failed trial" || step FAIL "session lost after the failed trial"
snap "after failed trial C"

# --- 4. lh rollback to the previous version ---
lh rollback --yes >>"$SH/update.log" || true
if wait_for "$SELFHOST_SWITCH_TIMEOUT_S" on_version "$VA" && wait_for 60 sh -c "node -e \"const s=require('$LHH/runtime/service-state.json'); process.exit(s.activeVersion==='$VA' && s.update?.status==='committed' ? 0 : 1)\""; then
	step ok "lh rollback returns to A and commits: state $(update_status)"
else
	step FAIL "lh rollback: health=$(health_version 2>&1) state=$(update_status 2>&1)"
fi
has_session "$SESSION" && step ok "session survives lh rollback" || step FAIL "session lost after lh rollback"
snap "after lh rollback"
cp "$LHH/userdata/logs/update.log" "$SH/launcher-update.log" 2>/dev/null || true
real_fingerprint >"$SH/real-install-after"
if cmp -s "$SH/real-install-before" "$SH/real-install-after"; then
	step ok "your real install is untouched (service pid and state, unit file, ~/.local/bin/lh, service-state.json hashes)"
else
	step FAIL "your real install changed during the run (if your real service updated itself meanwhile, rerun): $(diff "$SH/real-install-before" "$SH/real-install-after" | tr '\n' ' ')"
fi

echo "evidence: $SH (steps.log, status.txt, launcher-update.log, install.log, update.log)"
exit $FAILED
