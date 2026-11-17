#!/usr/bin/env bash
# stop.sh <RUN>: stop everything this run started, by pid file only (never by
# name), remove its throwaway homes and browser profiles and any systemd
# unit it created. Evidence (logs, results, screenshots, receipt) stays.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
RUN=${1:?usage: stop.sh <RUN>}
[ -d "$RUN" ] || die "no run folder $RUN"
# Selfhost first: its unit owns server children.
if [ -f "$RUN/selfhost/unit-name" ]; then
	unit=$(cat "$RUN/selfhost/unit-name")
	case "$unit" in lh-prove-*) ;; *) die "refusing to touch unit $unit" ;; esac
	systemctl --user disable --now "$unit.service" >/dev/null 2>&1
	rm -f "$HOME/.config/systemd/user/$unit.service"
	systemctl --user daemon-reload >/dev/null 2>&1
	systemctl --user reset-failed "$unit.service" >/dev/null 2>&1
	say "removed unit $unit.service"
fi
find "$RUN" -name '*.pid' -print0 | while IFS= read -r -d '' pidfile; do
	pid=$(cat "$pidfile")
	# Every process here was started with setsid, so its pid is its process
	# group: signal the group to take its children (next-server) with it.
	if kill -0 -- "-$pid" 2>/dev/null; then
		kill -TERM -- "-$pid" 2>/dev/null
		for _ in $(seq 1 20); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.25; done
		kill -0 -- "-$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null
		say "stopped $(basename "$pidfile" .pid) (group $pid)"
	fi
	rm -f "$pidfile"
done
for side in "$RUN"/*/; do
	rm -rf "$side/home" "$side/data" "$side/chrome-profile" "$side/config" "$side/lh-home" "$side/bin"
	rm -f "$side/instance.env" "$side/auth.json" "$side"/*-credentials.json*
done
say "stopped $RUN (evidence kept)"
