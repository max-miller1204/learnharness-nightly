#!/usr/bin/env bash
# stop.sh <RUN>: stop everything this run started, by pid file only (never by
# name), remove its throwaway homes and browser profiles and any systemd
# unit it created. Evidence (logs, results, screenshots, receipt) stays.
#
# Refuses anything but a run folder made by new-run.sh, and signals a pid
# only when that process's command line or environment names this run (so a
# stale pid file whose pid was reused is never signalled).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
ARG=${1:?usage: stop.sh <RUN>}
RUN=$(realpath -e -- "$ARG" 2>/dev/null) || die "no run folder $ARG"
case "$RUN" in
	"$REPO"/.prove-it/runs/[0-9]*T[0-9]*Z-*) ;;
	*) die "refusing: $RUN is not a run folder under $REPO/.prove-it/runs/ (made by new-run.sh)" ;;
esac
[ "$(dirname "$RUN")" = "$REPO/.prove-it/runs" ] || die "refusing: $RUN is not directly under .prove-it/runs/"

owned() { # <pid>: does this process belong to this run?
	grep -qaF -- "$RUN" "/proc/$1/cmdline" 2>/dev/null || grep -qaF -- "$RUN" "/proc/$1/environ" 2>/dev/null
}

# Selfhost first: its unit owns server children.
if [ -f "$RUN/selfhost/unit-name" ]; then
	unit=$(cat "$RUN/selfhost/unit-name")
	case "$unit" in lh-prove-[0-9a-f]*) ;; *) die "refusing to touch unit '$unit'" ;; esac
	file=$(systemctl --user show -p FragmentPath --value "$unit.service" 2>/dev/null)
	systemctl --user disable --now "$unit.service" >/dev/null 2>&1
	case "$file" in */"$unit.service") rm -f "$file" ;; esac
	systemctl --user daemon-reload >/dev/null 2>&1
	systemctl --user reset-failed "$unit.service" >/dev/null 2>&1
	say "removed unit $unit.service${file:+ ($file)}"
fi
find "$RUN" -name '*.pid' -print0 | while IFS= read -r -d '' pidfile; do
	pid=$(cat "$pidfile")
	case "$pid" in ''|*[!0-9]*) rm -f "$pidfile"; continue ;; esac
	if kill -0 "$pid" 2>/dev/null && ! owned "$pid"; then
		say "skipping $(basename "$pidfile" .pid): pid $pid no longer belongs to this run"
	elif kill -0 -- "-$pid" 2>/dev/null; then
		# Processes were started with setsid (Chrome by puppeteer, detached), so
		# the pid is its process group: signal the group to take children along.
		kill -TERM -- "-$pid" 2>/dev/null
		for _ in $(seq 1 20); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.25; done
		kill -0 -- "-$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null
		say "stopped $(basename "$pidfile" .pid) (group $pid)"
	fi
	rm -f "$pidfile"
done
# Tier B archives are ~100 MB each and rebuildable; their checksums stay in pack.log and feed/latest.json.
rm -f "$RUN"/selfhost/feed/*.tar.gz
rm -rf "$RUN"/selfhost/c-tree
for side in "$RUN"/*/; do
	rm -rf "${side}home" "${side}data" "${side}chrome-profile" "${side}config" "${side}lh-home" "${side}bin"
	rm -f "${side}instance.env" "${side}auth.json" "${side}"*-credentials.json*
done
say "stopped $RUN (evidence kept)"
