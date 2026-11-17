#!/usr/bin/env bash
# build.sh <RUN> head|base|both
#
# Production builds for a prove run: `next build` plus build-server.mjs, with
# LH_VERSION baked in (so the launcher can install the same build).
#   head: this checkout, reused when the working tree hasn't changed since
#         the last prove build (REUSE_HEAD_BUILD=1).
#   base: the merge-base with $PROVE_BASE_REF, built once per SHA into
#         $PROVE_CACHE/base/<sha>/ and shared by every run and worktree on
#         this machine (a lock makes parallel runs wait for one build).
# Prints "<side> <dir>" per side on stdout. Logs go to <RUN>/build-<side>.log.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

RUN=${1:?usage: build.sh <RUN> head|base|both}
SIDE=${2:?usage: build.sh <RUN> head|base|both}
mkdir -p "$RUN"

ensure_deps() { # <dir> <log>
	local dir=$1 log=$2
	if [ ! -d "$dir/node_modules" ] || [ "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]; then
		say "[$(basename "$dir")] npm ci + plugins:setup"
		(cd "$dir" && npm ci --no-audit --no-fund && npm run plugins:setup) >>"$log" 2>&1
	fi
}

next_build() { # <dir> <version> <log>
	local dir=$1 version=$2 log=$3 try
	for try in 1 2; do
		if (cd "$dir" && rm -rf .next/standalone && NEXT_TELEMETRY_DISABLED=1 LH_VERSION=$version npm run build && node scripts/build-server.mjs) >>"$log" 2>&1; then
			return 0
		fi
		# Next stops a build once to show a security-upgrade notice and says to
		# retry. Retry once, and say so: the notice belongs in the receipt.
		if [ $try = 1 ] && grep -q SecurityFatalError "$log"; then
			say "[$(basename "$dir")] next build stopped for a security-upgrade notice (see $log); retrying once"
			continue
		fi
		return 1
	done
	return 1
}

build_head() {
	local log=$RUN/build-head.log
	local version stamp want lock
	version="$(pkg_version "$REPO")$PROVE_HEAD_VERSION_SUFFIX"
	stamp=$REPO/.next/standalone/.prove-build
	lock=$(git -C "$REPO" rev-parse --path-format=absolute --git-path prove-build.lock)
	exec 8>"$lock"
	flock 8
	want="$(worktree_hash) $version"
	if [ "$REUSE_HEAD_BUILD" = 1 ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
		say "[head] reusing build for tree $(cut -d' ' -f1 "$stamp")"
	else
		local t0=$SECONDS saved
		ensure_deps "$REPO" "$log"
		say "[head] building $version"
		# next build rewrites the tracked next-env.d.ts; put the builder's copy back.
		saved=$(mktemp); cp "$REPO/next-env.d.ts" "$saved"
		next_build "$REPO" "$version" "$log" || { cp "$saved" "$REPO/next-env.d.ts"; rm -f "$saved"; tail -40 "$log" >&2; die "head build failed (log: $log)"; }
		cp "$saved" "$REPO/next-env.d.ts"; rm -f "$saved"
		printf '%s\n' "$want" >"$stamp"
		say "[head] built in $((SECONDS - t0))s"
	fi
	exec 8>&-
	echo "head $REPO"
}

build_base() {
	local log=$RUN/build-base.log
	local sha dir version
	sha=$(base_sha)
	dir=$PROVE_CACHE/base/$sha
	mkdir -p "$PROVE_CACHE/base"
	exec 9>"$PROVE_CACHE/base/$sha.lock"
	flock 9
	if [ -f "$dir/.prove-done" ]; then
		say "[base] reusing cached build of ${sha:0:12}"
		touch "$dir/.prove-done"
	else
		local t0=$SECONDS
		rm -rf "$dir"
		mkdir -p "$dir"
		git -C "$REPO" archive "$sha" | tar -x -C "$dir"
		version="$(pkg_version "$dir")$PROVE_BASE_VERSION_SUFFIX"
		if [ "$SEED_BASE_NEXT_CACHE" = 1 ] && [ -d "$REPO/.next/cache" ]; then
			mkdir -p "$dir/.next" && cp -r "$REPO/.next/cache" "$dir/.next/cache"
		fi
		ensure_deps "$dir" "$log" || { rm -rf "$dir"; die "base npm ci failed (log: $log)"; }
		say "[base] building ${sha:0:12} as $version"
		next_build "$dir" "$version" "$log" || { tail -40 "$log" >&2; rm -rf "$dir"; die "base build failed (log: $log)"; }
		echo "$sha $version" >"$dir/.prove-done"
		say "[base] built in $((SECONDS - t0))s"
	fi
	exec 9>&-
	# Keep the newest $BASE_CACHE_KEEP builds; never the one just used.
	# shellcheck disable=SC2012
	ls -1t "$PROVE_CACHE"/base/*/.prove-done 2>/dev/null | tail -n +"$((BASE_CACHE_KEEP + 1))" | while read -r done; do
		old=$(dirname "$done")
		[ "$old" = "$dir" ] || { say "[base] pruning $(basename "$old")"; rm -rf "$old"; }
	done
	echo "base $dir"
}

case "$SIDE" in
	head) build_head ;;
	base) build_base ;;
	both)
		if [ "$MAX_PARALLEL_BUILDS" -ge 2 ]; then
			build_head >"$RUN/.build-head.out" & h=$!
			build_base >"$RUN/.build-base.out" & b=$!
			ok=0
			wait $h || ok=1
			wait $b || ok=1
			cat "$RUN/.build-head.out" "$RUN/.build-base.out"
			rm -f "$RUN/.build-head.out" "$RUN/.build-base.out"
			[ $ok = 0 ] || die "a build failed; see $RUN/build-*.log"
		else
			build_head
			build_base
		fi
		;;
	*) die "side must be head, base or both" ;;
esac
