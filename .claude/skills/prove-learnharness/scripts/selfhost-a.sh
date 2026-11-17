#!/usr/bin/env bash
# selfhost-a.sh <RUN> head|base
#
# Selfhost tier A (routine): the launcher's own tests, then the `lh` CLI run
# from source against a throwaway LH_HOME with no install, where every command
# must refuse cleanly. No build, no systemd unit, no network. Writes
# <RUN>/<side>/selfhost-a/result.json (compare.mjs format) so head is diffed
# against base: the outputs are the observations.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
RUN=${1:?usage: selfhost-a.sh <RUN> head|base}
SIDE=${2:?usage: selfhost-a.sh <RUN> head|base}
case "$SIDE" in
	head) TREE=$REPO ;;
	base) TREE=$PROVE_CACHE/base/$(base_sha); [ -f "$TREE/.prove-done" ] || die "no base build; run build.sh $RUN base"
		exec 7>"$TREE.inuse"; flock -s 7 ;;  # not pruned while in use
	*) die "side must be head or base" ;;
esac
OUT=$RUN/$SIDE/selfhost-a
mkdir -p "$OUT"
H=$RUN/$SIDE/lh-home
rm -rf "$H"; mkdir -p "$H"

tests_ok=true
(cd "$TREE" && node --test selfhost/tests/*.test.ts) >"$OUT/launcher-tests.log" 2>&1 || tests_ok=false
summary=$(grep -E '^ℹ (tests|pass|fail) ' "$OUT/launcher-tests.log" | tr '\n' ' ' || true)

lh() { # run the source launcher in the throwaway home; never the user's
	env -i PATH="$PATH" HOME="$H" LH_HOME="$H/.learnharness" LH_SERVICE_NAME=lh-prove-a LH_BIN_DIR="$H/bin" \
		node --disable-warning=ExperimentalWarning "$TREE/selfhost/lh.ts" "$@" </dev/null 2>&1
}
obs=()
leaks=()
for cmd in "help" "status" "versions" "update" "rollback" "use 9.9.9" "restore" "logs" "__selftest-launcher" "bogus-command"; do
	# shellcheck disable=SC2086
	out=$(lh $cmd; echo "exit=$?")
	printf '$ lh %s\n%s\n\n' "$cmd" "$out" >>"$OUT/cli.txt"
	# Any mention of the real home's install, unit or shim is a leak, even next to the throwaway home.
	if printf '%s' "$out" | sed "s#$H#<home>#g" | grep -qE "$HOME/\.learnharness|learnharness\.service|$HOME/\.local/bin/lh"; then leaks+=("lh $cmd"); fi
	obs+=("lh $cmd -> $(printf '%s' "$out" | sed "s#$H#<home>#g" | tr '\n' ' ' | cut -c1-300)")
done

BUILD_ID=$( [ "$SIDE" = head ] && git -C "$TREE" rev-parse --short=12 HEAD || basename "$TREE" | cut -c1-12)
LEAKS=$(IFS=';'; printf '%s' "${leaks[*]-}")
node - "$OUT/result.json" "$SIDE" "$tests_ok" "$summary" "$BUILD_ID" "$LEAKS" "${obs[@]}" <<'EOF'
const fs = require("node:fs");
const [file, side, testsOk, summary, build, leakList, ...cli] = process.argv.slice(2);
const steps = [{ name: "launcher tests (node --test selfhost/tests)", ok: testsOk === "true", note: summary }];
const leaked = leakList ? leakList.split(";") : [];
steps.push({ name: "lh commands stay inside the throwaway home", ok: leaked.length === 0, note: leaked.join("; ") });
fs.writeFileSync(file, JSON.stringify({ side, build: `${side} ${build}`, steps, observations: { cli }, budgets: {} }, null, 2) + "\n");
for (const s of steps) console.log(`[${s.ok ? "ok" : "FAIL"}] ${s.name}: ${s.note}`);
console.log(`result: ${file}`);
process.exit(steps.every((s) => s.ok) ? 0 : 1);
EOF
