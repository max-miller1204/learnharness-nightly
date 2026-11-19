#!/usr/bin/env bash
# run-plan.sh <slug> [scope.mjs args, e.g. --files a,b or --base <ref>]
#
# Runs the whole plan scope.mjs prints, in one go, so a checker spends its
# turns on the evidence instead of typing commands:
#   - a new run folder, then each planned step in order;
#   - a failing setup step (build, start, health, electron launch) stops the
#     run as BLOCKED; a failing check (a drive, a compare, selfhost) is
#     evidence and the plan carries on;
#   - cleanup (stop.sh) always runs, even after a BLOCKED step or Ctrl-C;
#   - prints a summary: each check's result line, failing steps, and the run
#     folder. Prints the run folder alone on the last line.
# Exit: 0 every check passed (still not a verdict: read the evidence),
# 1 a check failed, or the change itself failed to build, start or launch
# (BROKEN: back to the builder), 2 BLOCKED (base or environment failed,
# a planned surface, unmapped files), 3 no app surface.
#
# --base <ref> is applied to the whole run (exported as PROVE_BASE_REF), so
# the scope, the base build and every comparison use the same base.
#
# Planned steps are exactly scope.mjs's; this script only executes them.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
SLUG=${1:?usage: run-plan.sh <slug> [scope.mjs args]}
shift
cd "$PROVE_SKILL" || { say "BLOCKED: no skill folder"; exit 2; }
# One base for everything: scope.mjs gets --base, and build.sh, start.sh and
# selfhost-*.sh read PROVE_BASE_REF.
args=("$@")
for i in "${!args[@]}"; do
	[ "${args[$i]}" = --base ] && [ -n "${args[$((i + 1))]:-}" ] && export PROVE_BASE_REF=${args[$((i + 1))]}
done

PLAN=$(node scripts/scope.mjs --json "$@") || { say "BLOCKED: scope.mjs failed"; exit 2; }
mapfile -t STEPS < <(node -e 'for (const l of JSON.parse(require("fs").readFileSync(0, "utf8")).plan) console.log(l)' <<<"$PLAN")
mapfile -t UNMAPPED < <(node -e 'for (const f of JSON.parse(require("fs").readFileSync(0, "utf8")).unmapped) console.log(f)' <<<"$PLAN")
if [ "${#UNMAPPED[@]}" -gt 0 ]; then
	# A file scope.mjs can't map may reach any surface: a person decides first.
	say "BLOCKED: scope.mjs could not map: ${UNMAPPED[*]}"
	say "decide by hand which surfaces these reach, add a rule to scope.mjs and SKILL.md's Scope map, then rerun"
	exit 2
fi
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
	scripts/stop.sh "$RUN" >>"$RUN/run-plan.log" 2>&1
}
trap cleanup EXIT
trap 'exit 130' INT TERM

checks_failed=0
failed_parts=()
blocked=""
head_failed=""
for step in "${STEPS[@]}"; do
	case "$step" in
		'RUN=$(scripts/new-run.sh'*) continue ;;                          # done above
		'node scripts/scope.mjs'*)                                         # same scope args as this run
			node scripts/scope.mjs "$@" >"$RUN/scope.txt" 2>&1; continue ;;
		*'scripts/stop.sh'*) continue ;;                                   # cleanup() does it
		'#'*) blocked="${step#\# }"; break ;;                              # a PLANNED surface: BLOCKED
	esac
	# A plan line chains commands with "; " (no planned command contains one);
	# run each on its own so every failure counts, not just the last one's.
	rest=${step%%   #*}   # drop a trailing "   # note" from the plan line
	while [ -n "$rest" ]; do
		part=${rest%%; *}
		[ "$part" = "$rest" ] && rest="" || rest=${rest#*; }
		printf '\n$ %s\n' "$part" >>"$RUN/run-plan.log"
		mark=$(wc -l <"$RUN/run-plan.log")
		eval "$part" >>"$RUN/run-plan.log" 2>&1 && continue
		out=$(tail -n +"$((mark + 1))" "$RUN/run-plan.log")
		case "$part" in
			*'build.sh'*)
				# The change's own build failing is BROKEN; the base's or the environment's is BLOCKED.
				if grep -q 'head build failed' <<<"$out" && ! grep -q 'base build failed' <<<"$out"; then
					head_failed="the change failed to build: $part"; break 2
				fi
				blocked="setup step failed: $part"; break 2 ;;
			*'start.sh "$RUN" head'*|*'health.sh "$H"'*|*'electron.sh'*)
				head_failed="the change failed to start: $part"; break 2 ;;
			*'start.sh'*|*'health.sh'*|*'ensure-axe.sh'*)
				blocked="setup step failed: $part"; break 2 ;;
			*)
				if grep -q 'prove: BLOCKED' <<<"$out"; then blocked="$(grep -m1 -o 'prove: BLOCKED.*' <<<"$out") ($part)"; break 2; fi
				checks_failed=$((checks_failed + 1)); failed_parts+=("$part") ;;
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
	for p in "${failed_parts[@]}"; do echo "failed: $p"; done
	[ -n "$head_failed" ] && echo "BROKEN: $head_failed (see run-plan.log and build-head.log or app.log)"
	[ -n "$blocked" ] && echo "BLOCKED: $blocked (see run-plan.log)"
} | tee "$RUN/summary.txt" >&2
echo "$RUN"
[ -n "$head_failed" ] && exit 1
[ -n "$blocked" ] && exit 2
[ "$checks_failed" -gt 0 ] && exit 1
exit 0
