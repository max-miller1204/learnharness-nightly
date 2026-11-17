#!/usr/bin/env bash
# run-plan.sh <slug> [scope.mjs args, e.g. --files a,b or --base <ref>]
#
# Runs the whole plan scope.mjs prints, in one go, so a checker spends its
# turns on the evidence instead of typing commands:
#   - a new run folder, then each planned step in order, each timed;
#   - a failing setup step (build, start, health, electron launch) stops the
#     run as BLOCKED; a failing check (a drive, a compare, selfhost) is
#     evidence and the plan carries on;
#   - cleanup (stop.sh) always runs, even after a BLOCKED step or Ctrl-C;
#   - prints a summary: each check's result line, failing steps, the timing
#     table, and the run folder. Prints the run folder alone on the last line.
# Exit: 0 every check passed (still not a verdict: read the evidence),
# 1 a check failed, 2 BLOCKED (setup failed or nothing to run), 3 no surface.
#
# Planned steps are exactly scope.mjs's; this script only executes them.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
SLUG=${1:?usage: run-plan.sh <slug> [scope.mjs args]}
shift
cd "$PROVE_SKILL" || die "no skill folder"

PLAN=$(node scripts/scope.mjs --json "$@") || die "BLOCKED: scope.mjs failed"
mapfile -t STEPS < <(node -e 'for (const l of JSON.parse(require("fs").readFileSync(0, "utf8")).plan) console.log(l)' <<<"$PLAN")
if [ "${#STEPS[@]}" -eq 0 ]; then
	node scripts/scope.mjs "$@" >&2
	say "no app surface reached: nothing to run (say so in the receipt)"
	exit 3
fi

RUN=$(scripts/new-run.sh "$SLUG") || exit 2
export RUN
H="" B="" E=""
CLEANED=0
cleanup() {
	[ "$CLEANED" = 1 ] && return
	CLEANED=1
	scripts/timed.sh "$RUN" "cleanup" scripts/stop.sh "$RUN" >>"$RUN/run-plan.log" 2>&1
	node scripts/timings.mjs "$RUN" >"$RUN/timings.md"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

checks_failed=0
blocked=""
for step in "${STEPS[@]}"; do
	case "$step" in
		'RUN=$(scripts/new-run.sh'*) continue ;;                          # done above
		*'"scope" node scripts/scope.mjs'*)                                # same scope args as this run
			scripts/timed.sh "$RUN" "scope" node scripts/scope.mjs "$@" >"$RUN/scope.txt" 2>&1; continue ;;
		*'scripts/stop.sh'*|*'scripts/timings.mjs'*) continue ;;           # cleanup() does both
		'#'*) blocked="${step#\# }"; break ;;                              # a PLANNED surface: BLOCKED
	esac
	# A plan line chains commands with "; " (no planned command contains one);
	# run each on its own so every failure counts, not just the last one's.
	rest=${step%%   #*}   # drop a trailing "   # note" from the plan line
	while [ -n "$rest" ]; do
		part=${rest%%; *}
		[ "$part" = "$rest" ] && rest="" || rest=${rest#*; }
		printf '\n$ %s\n' "$part" >>"$RUN/run-plan.log"
		eval "$part" >>"$RUN/run-plan.log" 2>&1 && continue
		case "$part" in
			*'build.sh'*|*'start.sh'*|*'health.sh'*|*'electron.sh'*|*'ensure-axe.sh'*)
				blocked="setup step failed: $part"; break 2 ;;
			*) checks_failed=$((checks_failed + 1)) ;;
		esac
	done
done

cleanup
{
	echo "== run-plan summary: $RUN"
	for f in "$RUN"/compare-*.md; do [ -f "$f" ] && printf '%-28s %s\n' "$(basename "$f")" "$(tail -1 "$f")"; done
	[ -f "$RUN/selfhost/steps.log" ] && echo "selfhost-b: $(grep -c '^\[ok\]' "$RUN/selfhost/steps.log") ok, $(grep -c '^\[FAIL\]' "$RUN/selfhost/steps.log") failed (selfhost/steps.log)"
	grep -h -- '- \[FAIL\]' "$RUN"/compare-*.md 2>/dev/null | head -20
	grep -h '^\[FAIL\]' "$RUN/selfhost/steps.log" 2>/dev/null
	[ -n "$blocked" ] && echo "BLOCKED: $blocked (see run-plan.log)"
	echo
	cat "$RUN/timings.md"
} | tee "$RUN/summary.txt" >&2
echo "$RUN"
[ -n "$blocked" ] && exit 2
[ "$checks_failed" -gt 0 ] && exit 1
exit 0
