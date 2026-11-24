#!/usr/bin/env bash
# The iOS half of the e2e setup, for the `ios` target in e2e.config.ts. Run it on a Mac with Xcode.
#
#   tests/e2e/support/ios.sh build            a Release simulator build of apps/mobile, written to $E2E_IOS_APP
#   tests/e2e/support/ios.sh device-create    a disposable simulator, booted; prints its udid on stdout
#   tests/e2e/support/ios.sh device-delete U  shuts down and deletes simulator U
#
# Environment (all optional):
#   E2E_IOS_APP           where `build` leaves the .app (default .e2e/ios/LearnHarnessNightly.app)
#   E2E_IOS_DERIVED_DATA  xcodebuild's DerivedData, kept between builds (default ~/.cache/learnharness-e2e/ios-derived-data)
#   E2E_IOS_DEVICE_TYPE   device-create's device type (default iPhone 17 Pro)
#   E2E_IOS_RUNTIME       device-create's runtime (default iOS 26.5)
#
# The build is a Release one, so the JavaScript bundle is embedded and no Metro runs, and it is made for
# the host's own simulator architecture. Expo's update check is switched off in the built app only
# (EXUpdatesEnabled in its Expo.plist), so a test never fetches an over-the-air update; apps/mobile/app.json
# is not touched. Node 22 builds the app (mise); the e2e run itself uses the repo's Node.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
mobile=$root/apps/mobile
app_out=${E2E_IOS_APP:-$root/.e2e/ios/LearnHarnessNightly.app}
derived=${E2E_IOS_DERIVED_DATA:-$HOME/.cache/learnharness-e2e/ios-derived-data}

log() { echo "ios.sh: $*" >&2; }
node22=

use_node22() {
	local dir
	dir=$(mise where node@22 2>/dev/null || true)
	[ -n "$dir" ] || { log "node 22 is missing: mise install node@22"; exit 1; }
	export PATH=$dir/bin:$PATH
	node22=$dir/bin/node
	export LANG=en_US.UTF-8 EXPO_NO_TELEMETRY=1 CI=1
}

# The native project is regenerated (and its pods installed) only when what it is made from changes.
native_fingerprint() {
	(cd "$mobile" && cat app.json package.json package-lock.json plugins/* | shasum | cut -d' ' -f1)
}

build() {
	use_node22
	cd "$mobile"
	if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
		log "npm ci in apps/mobile"
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

	local arch=x86_64
	[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ] && arch=arm64
	log "xcodebuild Release for $arch, DerivedData $derived"
	xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release -sdk iphonesimulator \
		-destination "generic/platform=iOS Simulator" -derivedDataPath "$derived" \
		ARCHS="$arch" ONLY_ACTIVE_ARCH=NO build -quiet >&2

	rm -rf "$app_out"
	mkdir -p "$(dirname "$app_out")"
	ditto "$derived/Build/Products/Release-iphonesimulator/$scheme.app" "$app_out"

	# The proof that this is the build the tests mean: a bundle inside, and no update check.
	[ -f "$app_out/main.jsbundle" ] || { log "no main.jsbundle in $app_out"; exit 1; }
	[ "$(/usr/libexec/PlistBuddy -c "Print :EXUpdatesEnabled" "$app_out/Expo.plist")" = false ] \
		|| { log "expo-updates is enabled in $app_out"; exit 1; }
	log "built $app_out"
}

device_create() {
	local type=${E2E_IOS_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}
	local runtime=${E2E_IOS_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}
	local udid
	udid=$(xcrun simctl create "lh-e2e-$$" "$type" "$runtime")
	# `boot` on a booted device exits 149; bootstatus -b boots a shut-down device and waits for it.
	xcrun simctl bootstatus "$udid" -b >&2
	echo "$udid"
}

device_delete() {
	local udid=${1:?usage: ios.sh device-delete <udid>}
	xcrun simctl shutdown "$udid" 2>/dev/null || true
	xcrun simctl delete "$udid"
}

case "${1:-}" in
	build) build ;;
	device-create) device_create ;;
	device-delete) device_delete "${2:-}" ;;
	*) echo "usage: ios.sh build | device-create | device-delete <udid>" >&2; exit 2 ;;
esac
