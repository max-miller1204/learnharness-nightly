#!/usr/bin/env bash
# new-run.sh <slug>: create .prove-it/runs/<UTC timestamp>-<slug>-<random>/
# and print its path. The folder must not exist yet, so two runs never share
# one. Also reports leftovers from earlier runs that are still alive (never
# touches them).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
SLUG=${1:?usage: new-run.sh <slug>}
case "$SLUG" in *[!A-Za-z0-9._-]*|'') die "slug may use letters, digits, '.', '_' and '-' only" ;; esac
for pid in "$REPO"/.prove-it/runs/*/*/*.pid "$REPO"/.prove-it/runs/*/*.pid; do
	[ -f "$pid" ] || continue
	pid_alive "$pid" && say "leftover: $pid is still running (stop it with stop.sh on its run folder)"
done
mkdir -p "$REPO/.prove-it/runs"
RUN=$REPO/.prove-it/runs/$(date -u +%Y%m%dT%H%M%SZ)-$SLUG-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
mkdir "$RUN"
echo "$RUN"
