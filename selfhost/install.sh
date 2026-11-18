#!/bin/sh
# LearnHarness nightly installer (self-hosted server: Linux x64/arm64, macOS on Apple silicon).
#
#   curl -fsSL https://github.com/max-miller1204/learnharness-nightly/releases/download/nightly/install.sh | sh
#
# Downloads the newest nightly listed in latest.json, checks its SHA-256,
# unpacks it into ~/.learnharness/runtime/versions/<version>/, registers it
# and runs `lh up`. Running it again installs the newest version and never
# touches your data. Environment: LH_HOME (default ~/.learnharness),
# LH_FEED_URL (default: this fork's latest.json), LH_YES=1 (no questions),
# LH_UP_ARGS (extra flags for `lh up`, e.g. "--no-tailscale --no-linger").
set -eu

FEED_URL="${LH_FEED_URL:-https://github.com/max-miller1204/learnharness-nightly/releases/download/nightly/latest.json}"
LH_HOME="${LH_HOME:-$HOME/.learnharness}"

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

case "$(uname -s)" in
	Linux)
		case "$(uname -m)" in
			x86_64|amd64) ARCH=linux-x64 ;;
			aarch64|arm64) ARCH=linux-arm64 ;;
			*) die "unsupported CPU $(uname -m); x86_64 and aarch64 are supported." ;;
		esac
		command -v systemctl >/dev/null 2>&1 || die "systemd is required (systemctl not found)."
		;;
	Darwin)
		# Ask the hardware: a terminal running under Rosetta reports x86_64.
		[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ] || die "LearnHarness self-hosting on macOS needs Apple silicon; Intel Macs aren't supported."
		ARCH=darwin-arm64
		command -v launchctl >/dev/null 2>&1 || die "launchctl not found."
		;;
	*) die "LearnHarness self-hosting supports Linux (x86_64, aarch64) and macOS (Apple silicon)." ;;
esac
need curl; need tar
if command -v sha256sum >/dev/null 2>&1; then
	sha256check() { sha256sum -c - >/dev/null; }
elif command -v shasum >/dev/null 2>&1; then
	sha256check() { shasum -a 256 -c - >/dev/null; }
else
	die "sha256sum or shasum is required"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch() {
	case "$1" in
		file://*) cp "${1#file://}" "$2" ;;
		*) curl -fsSL --retry 3 -o "$2" "$1" ;;
	esac
}

say "Reading $FEED_URL"
fetch "$FEED_URL" "$TMP/latest.json"
# latest.json is machine-written; pick fields without needing jq. Top-level
# fields come before "assets", and the release notes after it repeat
# "version", so only the part before "assets" is searched.
field() { tr -d '\n' < "$TMP/latest.json" | sed 's/"assets".*//' | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p"; }
VERSION=$(field version)
[ -n "$VERSION" ] || die "latest.json has no version"
ASSET=$(tr -d '\n' < "$TMP/latest.json" | sed -n "s/.*\"$ARCH\"[[:space:]]*:[[:space:]]*{\\([^}]*\\)}.*/\\1/p")
URL=$(printf '%s' "$ASSET" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
SHA=$(printf '%s' "$ASSET" | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p')
[ -n "$URL" ] && [ -n "$SHA" ] || die "the newest nightly ($VERSION) has no $ARCH build"

DEST="$LH_HOME/runtime/versions/$VERSION"
if [ -f "$DEST/.install-complete" ]; then
	say "LearnHarness $VERSION is already downloaded."
else
	say "Downloading LearnHarness $VERSION ($ARCH)"
	fetch "$URL" "$TMP/lh.tar.gz"
	printf '%s  %s\n' "$SHA" "$TMP/lh.tar.gz" | sha256check || die "checksum mismatch; not installing"
	rm -rf "$DEST.tmp"
	mkdir -p "$DEST.tmp"
	tar -xzf "$TMP/lh.tar.gz" -C "$DEST.tmp" --no-same-owner
	[ "$(cat "$DEST.tmp/VERSION")" = "$VERSION" ] || die "archive version does not match $VERSION"
	rm -rf "$DEST"
	mv "$DEST.tmp" "$DEST"
fi

export LH_HOME
"$DEST/lh" __install
# A custom feed (testing, mirrors) is remembered so in-app updates use it too.
FEED_FLAG=""
[ -n "${LH_FEED_URL:-}" ] && FEED_FLAG="--feed-url=$LH_FEED_URL"
# shellcheck disable=SC2086 # LH_UP_ARGS is a flag list on purpose
if [ "${LH_YES:-}" = "1" ]; then
	exec "$DEST/lh" up --yes $FEED_FLAG ${LH_UP_ARGS:-}
fi
# Reattach the terminal so `lh up` can ask its questions when piped from curl.
if [ -r /dev/tty ] && (exec < /dev/tty) 2>/dev/null; then
	exec "$DEST/lh" up $FEED_FLAG ${LH_UP_ARGS:-} < /dev/tty
fi
exec "$DEST/lh" up --yes $FEED_FLAG ${LH_UP_ARGS:-}
