# Shared helpers for prove-learnharness scripts. Source it; don't run it.
# shellcheck shell=bash

PROVE_SCRIPTS=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROVE_SKILL=$(dirname "$PROVE_SCRIPTS")
REPO=$(git -C "$PROVE_SCRIPTS" rev-parse --show-toplevel)
# shellcheck source=knobs.env
. "$PROVE_SCRIPTS/knobs.env"

die() { printf 'prove: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*" >&2; }

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

# Wait until a command succeeds, or fail after $1 seconds.
wait_for() {
	local timeout=$1; shift
	local deadline=$(( $(date +%s) + timeout ))
	until "$@" >/dev/null 2>&1; do
		[ "$(date +%s)" -lt "$deadline" ] || return 1
		sleep 0.5
	done
}

# Is the pid in this file alive?
pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# Append one row to <RUN>/timings.tsv (same format as timed.sh).
record_time() { # <RUN> <phase> <start epoch> [exit]
	local run=$1 phase=$2 start=$3 code=${4:-0}
	[ -f "$run/timings.tsv" ] || printf 'phase\tstart\tend\tseconds\texit\n' >"$run/timings.tsv"
	printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$(date -u -d "@${start%.*}" +%FT%TZ)" "$(date -u +%FT%TZ)" \
		"$(awk -v a="$start" -v b="$(date +%s.%N)" 'BEGIN{printf "%.1f", b-a}')" "$code" >>"$run/timings.tsv"
}

pkg_version() { node -p "require('$1/package.json').version"; }

# The base commit: merge-base of HEAD and the base ref (fetch first if it moved).
base_sha() {
	git -C "$REPO" merge-base HEAD "$PROVE_BASE_REF"
}

# A hash of the working tree as it is now: tracked and untracked files, minus
# ignored ones. Two equal hashes mean the same sources, so the same build.
worktree_hash() {
	local index
	index=$(mktemp)
	cp "$(git -C "$REPO" rev-parse --path-format=absolute --git-path index)" "$index"
	GIT_INDEX_FILE=$index git -C "$REPO" add -A >/dev/null 2>&1
	# This skill's own files never reach the build; next-env.d.ts is rewritten by it.
	GIT_INDEX_FILE=$index git -C "$REPO" rm -r -q --cached --ignore-unmatch .claude next-env.d.ts >/dev/null 2>&1
	GIT_INDEX_FILE=$index git -C "$REPO" write-tree
	rm -f "$index"
}
