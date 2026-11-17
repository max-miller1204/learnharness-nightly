#!/usr/bin/env bash
# new-run.sh <slug>: create .prove-it/runs/<UTC timestamp>-<slug>/ and print its path.
# Also reports leftovers from earlier runs that are still alive (never touches them).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
SLUG=${1:?usage: new-run.sh <slug>}
for pid in "$REPO"/.prove-it/runs/*/*/*.pid "$REPO"/.prove-it/runs/*/*.pid; do
	[ -f "$pid" ] || continue
	pid_alive "$pid" && say "leftover: $pid is still running (stop it with stop.sh on its run folder)"
done
RUN=$REPO/.prove-it/runs/$(date -u +%Y%m%dT%H%M%SZ)-$SLUG
mkdir -p "$RUN"
echo "$RUN"
