#!/usr/bin/env bash
# The iOS half of the e2e setup, for the `ios` target in e2e.config.ts. Run it on a Mac with Xcode.
#
#   tests/e2e/support/ios.sh build              a Release simulator build of apps/mobile, written to $E2E_IOS_APP
#   tests/e2e/support/ios.sh e2e <command...>   `e2e <command...> --target ios` on a simulator made for this run:
#                                               e2e run | e2e explore | e2e mcp | e2e list ...
#   tests/e2e/support/ios.sh devices            the simulators this script made and whether their run is alive
#   tests/e2e/support/ios.sh device-delete U    deletes simulator U, only if this script made it and its run is gone
#
# `e2e` is the only way to run the phone. It owns the whole run: it creates a simulator named lh-e2e-<run id>
# and records it, allocates two free ports, runs e2e pinned to that simulator, and deletes the simulator on
# exit, failure or interruption (the cleanup is registered before the simulator exists). The config and the
# test fixture refuse any simulator this script did not create, so a simulator you use is never touched.
#
# `build` makes the app in a copy of apps/mobile under .e2e/ios-build, so the checkout's own native project
# (apps/mobile/ios) and env files are never read or written. It is a Release build, so the JavaScript bundle is
# embedded and no Metro runs. The destination is a simulator made for the build, and Xcode picks its architecture
# slice, so the same command works on Intel and Apple silicon. Expo's update check is switched off in the built
# app only (EXUpdatesEnabled in its Expo.plist), so a test never fetches an over-the-air update; apps/mobile/app.json
# is not touched. Node 22 builds the app (mise); the e2e run itself uses the repo's Node.
#
# Environment (all optional):
#   E2E_IOS_APP           where `build` leaves the .app and `e2e` reads it (default .e2e/ios/LearnHarnessNightly.app),
#                         relative to the repo root
#   E2E_IOS_DERIVED_DATA  xcodebuild's DerivedData, kept between builds (default ~/.cache/learnharness-e2e/ios-derived-data)
#   E2E_IOS_DEVICE_TYPE   the simulator's device type (default iPhone 17 Pro)
#   E2E_IOS_RUNTIME       the simulator's runtime (default iOS 26.5)
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
tmp=${TMPDIR:-/tmp}; tmp=${tmp%/}
registry=$tmp/learnharness-e2e/ios-sims
tree=$root/.e2e/ios-build
app_out=${E2E_IOS_APP:-.e2e/ios/LearnHarnessNightly.app}
case $app_out in /*) ;; *) app_out=$root/$app_out ;; esac
derived=${E2E_IOS_DERIVED_DATA:-$HOME/.cache/learnharness-e2e/ios-derived-data}
device_type=${E2E_IOS_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}
runtime=${E2E_IOS_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}
prefix=lh-e2e-

log() { echo "ios.sh: $*" >&2; }
die() { log "$*"; exit 1; }

# ---- the simulator this run owns ------------------------------------------------------------------

run_id= sim_name= udid= child= signalled= inst_port=

# Deletes what this run made: the simulator (found by name, so an interruption between `simctl create` and
# the capture of its udid cannot leak one), its record, its agent-device session folder and its server's
# instance folder. Safe to run twice, by the cleanup and by the reaper.
remove_leftovers() {
	local found
	if [ -n "$sim_name" ]; then
		found=$(xcrun simctl list devices 2>/dev/null | grep -F " $sim_name (" | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/' || true)
		for found in $found; do
			xcrun simctl shutdown "$found" >/dev/null 2>&1 || true
			xcrun simctl delete "$found" >/dev/null 2>&1 || log "could not delete simulator $found ($sim_name)"
			rm -f "$registry/$found.json"
		done
	fi
	[ -z "$inst_port" ] || rm -rf "$tmp/learnharness-e2e/$inst_port"
	# agent-device keeps a folder per session; this run's own is named after it.
	if [ -n "$run_id" ]; then
		for found in "$HOME/.agent-device/sessions/lh-e2e-$run_id"-*; do [ -d "$found" ] && rm -rf "$found"; done
	fi
	return 0
}

# Runs `remove_leftovers` once this script is gone, however it went: a client that closes an MCP server gives
# it a couple of seconds before SIGKILL, which is less than a simulator takes to shut down.
start_reaper() {
	local owner=$$ pidfile=$registry/$run_id.child
	(
		trap '' INT HUP TERM
		while kill -0 "$owner" 2>/dev/null; do sleep 1; done
		# The e2e process outlives a script that was killed: stop it (it stops its server) before the simulator goes.
		pid=$(cat "$pidfile" 2>/dev/null || true)
		if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
			kill -TERM "$pid" 2>/dev/null || true
			for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
			kill -KILL "$pid" 2>/dev/null || true
		fi
		rm -f "$pidfile"
		remove_leftovers
	) </dev/null >/dev/null 2>&1 &
}

cleanup() {
	local rc=$?
	trap - EXIT INT TERM HUP
	if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
		kill -TERM "$child" 2>/dev/null || true
		for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do kill -0 "$child" 2>/dev/null || break; sleep 1; done
		kill -KILL "$child" 2>/dev/null || true
	fi
	remove_leftovers
	[ -z "$signalled" ] || rc=130
	exit "$rc"
}

# A signal goes to the child, and the cleanup runs once it is gone.
on_signal() {
	signalled=$1
	if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then kill -"$1" "$child" 2>/dev/null || true; else exit 130; fi
}

create_simulator() {
	trap cleanup EXIT
	trap 'on_signal INT' INT
	trap 'on_signal TERM' TERM
	trap 'on_signal HUP' HUP
	run_id=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
	sim_name=$prefix$run_id
	udid=$(xcrun simctl create "$sim_name" "$device_type" "$runtime")
	mkdir -p "$registry"
	( umask 077; printf '{"udid":"%s","name":"%s","pid":%s,"run":"%s"}\n' "$udid" "$sim_name" "$$" "$run_id" >"$registry/$udid.json" )
	log "simulator $sim_name ($udid)"
	start_reaper
}

# Runs "$@" in the background and waits, so a signal reaches this script's trap while the child runs.
run_child() {
	# `<&0` keeps this script's stdin: a background command would otherwise read /dev/null, and `e2e mcp` talks over stdin.
	"$@" <&0 &
	child=$!
	[ -z "$run_id" ] || echo "$child" >"$registry/$run_id.child"
	local rc=0
	while :; do
		wait "$child" && rc=0 || rc=$?
		kill -0 "$child" 2>/dev/null || break
	done
	child=
	[ -z "$run_id" ] || rm -f "$registry/$run_id.child"
	return "$rc"
}

# ---- build --------------------------------------------------------------------------------------

use_node22() {
	local dir
	dir=$(mise where node@22 2>/dev/null || true)
	[ -n "$dir" ] || die "node 22 is missing: mise install node@22"
	export PATH=$dir/bin:$PATH
	export LANG=en_US.UTF-8 EXPO_NO_TELEMETRY=1 CI=1
	node22=$dir/bin/node
}

# What the native project is made from: it is regenerated (and its pods installed) only when this changes.
native_fingerprint() {
	(cd "$tree/apps/mobile" && cat app.json package.json package-lock.json plugins/* | shasum | cut -d' ' -f1)
}

# A copy of what apps/mobile needs, laid out as in the checkout (its Metro config and app.json reach ../../src,
# ../../public/fonts and ../../build/icon.png). node_modules and ios live only in the copy.
sync_tree() {
	mkdir -p "$tree/apps/mobile" "$tree/public" "$tree/build"
	rsync -a --delete --exclude node_modules --exclude ios --exclude .expo --exclude tests "$root/apps/mobile/" "$tree/apps/mobile/"
	rsync -a --delete "$root/src/" "$tree/src/"
	rsync -a --delete "$root/public/fonts/" "$tree/public/fonts/"
	cp "$root/build/icon.png" "$tree/build/icon.png"
}

build_app() {
	use_node22
	sync_tree
	cd "$tree/apps/mobile"
	if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
		log "npm ci in the build tree"
		npm ci --no-audit --no-fund
	fi

	local fingerprint
	fingerprint=$(native_fingerprint)
	if [ ! -d ios ] || [ "$(cat ios/.e2e-fingerprint 2>/dev/null || true)" != "$fingerprint" ]; then
		log "expo prebuild and pod install"
		npx expo prebuild --clean --platform ios --no-install
		(cd ios && pod install)
		echo "$fingerprint" >ios/.e2e-fingerprint
	fi

	local workspace scheme plist
	workspace=$(ls -d ios/*.xcworkspace | head -1)
	scheme=$(basename "$workspace" .xcworkspace)
	plist=ios/$scheme/Supporting/Expo.plist
	/usr/libexec/PlistBuddy -c "Set :EXUpdatesEnabled false" "$plist"
	# The bundling step in Xcode reads the node to run from here; pod install writes the first node on a different PATH.
	echo "export NODE_BINARY=$node22" >ios/.xcode.env.local

	# A concrete destination: a simulator made for this build (never booted). ONLY_ACTIVE_ARCH makes Xcode
	# build the slice that simulator runs, so no architecture is named here.
	create_simulator
	log "xcodebuild Release for simulator $udid, DerivedData $derived"
	run_child xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release -sdk iphonesimulator \
		-destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$derived" \
		ONLY_ACTIVE_ARCH=YES build -quiet >&2

	rm -rf "$app_out"
	mkdir -p "$(dirname "$app_out")"
	ditto "$derived/Build/Products/Release-iphonesimulator/$scheme.app" "$app_out"

	# The proof that this is the build the tests mean: a bundle inside, and no update check.
	[ -f "$app_out/main.jsbundle" ] || die "no main.jsbundle in $app_out"
	[ "$(/usr/libexec/PlistBuddy -c "Print :EXUpdatesEnabled" "$app_out/Expo.plist")" = false ] \
		|| die "expo-updates is enabled in $app_out"
	log "built $app_out"
}

# ---- run e2e --------------------------------------------------------------------------------------

free_ports() {
	node -e 'const net=require("net");const a=net.createServer(),b=net.createServer();a.listen(0,"127.0.0.1",()=>b.listen(0,"127.0.0.1",()=>{console.log(a.address().port+" "+b.address().port);a.close();b.close()}))'
}

e2e_run() {
	[ $# -gt 0 ] || die "usage: ios.sh e2e <run|explore|mcp|list ...>"
	for arg in "$@"; do case $arg in --target|--target=*) die "ios.sh e2e picks the target itself; drop $arg" ;; esac; done
	[ -d "$app_out" ] || die "no build at $app_out: run tests/e2e/support/ios.sh build first"
	[ -x "$root/node_modules/.bin/e2e" ] || die "no node_modules/.bin/e2e: run npm ci at the repo root"
	local ports
	ports=$(free_ports)
	inst_port=${ports% *}
	create_simulator
	cd "$root"
	E2E_IOS_RUN=$run_id E2E_IOS_DEVICE=$udid E2E_IOS_SIM_RECORD=$registry/$udid.json E2E_IOS_APP=$app_out \
		E2E_IOS_PORT=${ports% *} E2E_IOS_TLS_PORT=${ports#* } \
		run_child "$root/node_modules/.bin/e2e" "$@" --target ios
}

# ---- orphans ----------------------------------------------------------------------------------------

record_field() { sed -E "s/.*\"$2\":\"?([^\",}]*)\"?.*/\1/" "$1"; }

devices() {
	local file
	for file in "$registry"/*.json; do
		[ -e "$file" ] || continue
		local pid
		pid=$(record_field "$file" pid)
		echo "$(record_field "$file" udid) $(record_field "$file" name) run pid $pid $(kill -0 "$pid" 2>/dev/null && echo alive || echo gone)"
	done
}

device_delete() {
	local target=${1:?usage: ios.sh device-delete <udid>}
	local file=$registry/$target.json
	[ -f "$file" ] || die "$target was not created by ios.sh: not deleting it"
	local name pid
	name=$(record_field "$file" name)
	pid=$(record_field "$file" pid)
	case $name in $prefix*) ;; *) die "$name is not named like an ios.sh simulator: not deleting it" ;; esac
	xcrun simctl list devices | grep -qF "$name ($target)" || die "$target is not named $name: not deleting it"
	! kill -0 "$pid" 2>/dev/null || die "the run that made $target (pid $pid) is still alive: not deleting it"
	xcrun simctl shutdown "$target" >/dev/null 2>&1 || true
	xcrun simctl delete "$target"
	rm -f "$file"
	log "deleted $name ($target)"
}

case "${1:-}" in
	build) build_app ;;
	e2e) shift; e2e_run "$@" ;;
	devices) devices ;;
	device-delete) device_delete "${2:-}" ;;
	*) echo "usage: ios.sh build | e2e <e2e command...> | devices | device-delete <udid>" >&2; exit 2 ;;
esac
