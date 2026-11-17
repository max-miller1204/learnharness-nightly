#!/usr/bin/env bash
# timed.sh <RUN> <phase> <command...>
#
# Runs one phase of a prove run and appends its wall-clock time to
# <RUN>/timings.tsv (phase, start, end, seconds, exit code). Output and exit
# code pass through unchanged, so it wraps any step: build, start, a drive,
# a compare, cleanup. `node scripts/timings.mjs <RUN>` prints the table for
# the receipt and the PR comment.
set -uo pipefail
RUN=${1:?usage: timed.sh <RUN> <phase> <command...>}
PHASE=${2:?usage: timed.sh <RUN> <phase> <command...>}
shift 2
[ $# -gt 0 ] || { echo "timed.sh: no command" >&2; exit 2; }
mkdir -p "$RUN"
[ -f "$RUN/timings.tsv" ] || printf 'phase\tstart\tend\tseconds\texit\n' >"$RUN/timings.tsv"
start=$(date +%s.%N)
startIso=$(date -u +%FT%TZ)
"$@"
code=$?
end=$(date +%s.%N)
printf '%s\t%s\t%s\t%s\t%s\n' "$PHASE" "$startIso" "$(date -u +%FT%TZ)" "$(awk -v a="$start" -v b="$end" 'BEGIN{printf "%.1f", b-a}')" "$code" >>"$RUN/timings.tsv"
exit $code
