#!/usr/bin/env bash
# Mirror upstream issues into this fork (also used by
# .github/workflows/mirror-upstream-issues.yml). Design:
# docs/specs/upstream-issue-mirror.md.
#
#   selfhost/scripts/mirror-upstream-issues.sh [upstream issue number]
#
# Copies each upstream issue once (title, body, and the comments that exist
# then) into a fork issue labeled `upstream`, and keeps the `upstream-closed`
# label matching upstream's open or closed state. A hidden first line in the
# mirror body (`<!-- upstream-issue: <repo>#<N> -->`) links it to its upstream
# issue; only issues the fork bot App opened count, so an issue anyone else
# opens with that line can't stand in for a mirror. Upstream references and
# authors are written as code and the copied text sits in code blocks (see
# fence.jq), so nothing pings anyone or adds a "mentioned this" entry upstream.
#
# With a number, mirrors just that issue (even an older closed one). Writes
# only from the workflow (GITHUB_ACTIONS=true), as the fork bot App, because
# mirrors anyone else opens aren't recognized and would be copied again.
# Locally, run it with DRY_RUN=1 and your `gh` login: it prints what it would
# do without writing (with a number, it also prints the body).
set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-amosblomqvist/learnharness}"
FORK_REPO="${FORK_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
# Upstream issues numbered above this are mirrored even if already closed; at
# or below it (the backfill), only open ones.
NEW_AFTER="${NEW_AFTER:-792}"
MAX_NEW="${MAX_NEW:-100}"
# The fork bot App's login: only issues it opened count as mirrors.
FORK_BOT_LOGIN="${FORK_BOT_LOGIN:-learnharness-nightly-bot[bot]}"
DRY_RUN="${DRY_RUN:-}"
ONLY="${1:-}"
[ -z "$ONLY" ] || [[ "$ONLY" =~ ^[0-9]+$ ]] || { echo "Issue number must be numeric" >&2; exit 1; }
if [ -z "$DRY_RUN" ] && [ "${GITHUB_ACTIONS:-}" != true ]; then
	echo "Only the Mirror upstream issues workflow writes mirrors (as ${FORK_BOT_LOGIN}); run locally with DRY_RUN=1." >&2
	exit 1
fi
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
today=$(date -u +%F)

# Each write is followed by a pause (1 second, or the first argument) to stay
# under GitHub's secondary write limits.
write() {
	local pause=1
	[[ "$1" =~ ^[0-9]+$ ]] && { pause=$1; shift; }
	if [ -n "$DRY_RUN" ]; then
		echo "DRY_RUN: $*"
	else
		"$@" >/dev/null
		sleep "$pause"
	fi
}

# Every page of a list endpoint as one JSON array.
list() { gh api --paginate "$1" | jq -s 'add // []'; }

write gh label create upstream -R "$FORK_REPO" --force --color 1d76db --description "Mirrored from amosblomqvist/learnharness"
write gh label create upstream-closed -R "$FORK_REPO" --force --color cfd3d7 --description "Closed upstream; this copy stays open"

list "repos/${UPSTREAM_REPO}/issues?state=all&per_page=100" |
	jq '[.[] | select(.pull_request == null)
		| {number, state, title, body, html_url, created_at, user: .user.login, labels: [.labels[].name]}]' >"$tmp/upstream.json"

# Existing mirrors: fork issues the bot opened, matched by the marker on their
# first line.
list "repos/${FORK_REPO}/issues?state=all&per_page=100" |
	jq --arg prefix "<!-- upstream-issue: ${UPSTREAM_REPO}#" --arg bot "$FORK_BOT_LOGIN" '[.[] | select(.pull_request == null)
		| select(.user.login == $bot)
		| ((.body // "") | split("\n")[0]) as $first
		| select($first | startswith($prefix))
		| {fork: .number, upstream: ($first | ltrimstr($prefix) | rtrimstr(" -->") | rtrimstr(" -->\r") | tonumber? // empty),
			labels: [.labels[].name]}]' >"$tmp/mirrors.json"

gh label list -R "$FORK_REPO" --limit 1000 --json name --jq '[.[].name]' >"$tmp/fork-labels.json"

if [ -n "$ONLY" ] && ! jq -e --argjson n "$ONLY" 'any(.[]; .number == $n)' "$tmp/upstream.json" >/dev/null; then
	echo "Upstream issue ${ONLY} not found (or it's a PR)." >&2
	exit 1
fi

# Unmirrored issues to copy, oldest first.
jq --slurpfile mirrors "$tmp/mirrors.json" --argjson after "$NEW_AFTER" --arg only "$ONLY" '
	($mirrors[0] | map(.upstream)) as $done
	| [.[] | select(.number as $n | $done | index($n) | not)
		| select(if $only != "" then .number == ($only | tonumber) else .state == "open" or .number > $after end)]
	| sort_by(.number)' "$tmp/upstream.json" >"$tmp/todo.json"

if [ -n "$ONLY" ] && jq -e --argjson n "$ONLY" 'any(.[]; .upstream == $n)' "$tmp/mirrors.json" >/dev/null; then
	echo "Upstream issue ${ONLY} is already mirrored."
fi

backlog=$(jq length "$tmp/todo.json")
# Each loop reads a file written beforehand, so a jq error fails the run
# (set -e) instead of silently ending the loop early.
jq -r --argjson max "$MAX_NEW" '.[:$max][] | .number' "$tmp/todo.json" >"$tmp/todo.txt"
created=0
while IFS= read -r n <&3; do
	jq --argjson n "$n" '.[] | select(.number == $n)' "$tmp/todo.json" >"$tmp/issue.json"
	list "repos/${UPSTREAM_REPO}/issues/${n}/comments?per_page=100" |
		jq '[.[] | {user: .user.login, created_at, body}]' >"$tmp/comments.json"
	jq -r -L "$here" --slurpfile comments "$tmp/comments.json" --arg up "$UPSTREAM_REPO" --arg today "$today" -f /dev/stdin "$tmp/issue.json" >"$tmp/body.md" <<'JQ'
include "fence";
def day: .[0:10];
def render($cs; $more; $cut):
	"<!-- upstream-issue: \($up)#\(.number) -->\n"
	+ "Mirrored from `\($up)#\(.number)` (`\(.html_url)`), opened by `\(.user)` on \(.created_at | day). "
	+ "Copied once on \($today); later upstream edits and comments aren't synced.\n\n"
	+ "<details open><summary>Original issue</summary>\n\n" + (.body | fence("(empty)"))
	+ (if $cut then "\nTruncated; read the rest upstream.\n" else "" end)
	+ "\n</details>\n"
	+ (if ($cs | length) + $more > 0 then
		"\n<details><summary>Comments at copy time (\(($cs | length) + $more))</summary>\n\n"
		+ ($cs | map("**`\(.user)`** on \(.created_at | day):\n\n" + (.body | fence("(empty)"))) | join("\n"))
		+ (if $more > 0 then "\n\($more) more comment\(if $more == 1 then " upstream; read it" else "s upstream; read them" end) there.\n" else "" end)
		+ "\n</details>\n"
	else "" end);
# GitHub caps a body at 65536 characters: drop comments from the end, then
# cut the issue body, until the mirror fits in 60000 bytes.
def fit($cs; $keep; $cut):
	render($cs[:$keep]; ($cs | length) - $keep; $cut) as $b
	| if ($b | utf8bytelength) <= 60000 then $b
	elif $keep > 0 then fit($cs; $keep - 1; $cut)
	else (.body |= .[:((length * 9 / 10) | floor)]) | fit($cs; 0; true) end;
fit($comments[0]; $comments[0] | length; false)
JQ
	title=$(jq -r '"[upstream issue \(.number)] \(.title[:230])"' "$tmp/issue.json") # GitHub caps titles at 256
	jq -r --slurpfile have "$tmp/fork-labels.json" '
		["upstream"] + [.labels[] | select(. as $l | $have[0] | index($l))]
		+ (if .state == "closed" then ["upstream-closed"] else [] end) | unique | .[]' "$tmp/issue.json" >"$tmp/labels.txt"
	mapfile -t labels <"$tmp/labels.txt"
	label_args=()
	for l in "${labels[@]}"; do label_args+=(--label "$l"); done
	# Issue creation also has an anti-spam check that rejects fast bulk creates.
	write 3 gh issue create -R "$FORK_REPO" --title "$title" --body-file "$tmp/body.md" "${label_args[@]}"
	if [ -n "$DRY_RUN" ] && [ -n "$ONLY" ]; then cat "$tmp/body.md"; fi
	created=$((created + 1))
done 3<"$tmp/todo.txt"

# Keep `upstream-closed` matching upstream's state. Fork open/closed is never touched.
jq -r --slurpfile up "$tmp/upstream.json" '
	($up[0] | map({key: (.number | tostring), value: .state}) | from_entries) as $state
	| .[] | ($state[.upstream | tostring] // empty) as $s
	| (.labels | index("upstream-closed") != null) as $has
	| if $s == "closed" and ($has | not) then "\(.fork)\tadd"
	elif $s == "open" and $has then "\(.fork)\tremove"
	else empty end' "$tmp/mirrors.json" >"$tmp/relabel.txt"
added=0
removed=0
while IFS=$'\t' read -r fork action <&3; do
	if [ "$action" = add ]; then
		write gh issue edit "$fork" -R "$FORK_REPO" --add-label upstream-closed
		added=$((added + 1))
	else
		write gh issue edit "$fork" -R "$FORK_REPO" --remove-label upstream-closed
		removed=$((removed + 1))
	fi
done 3<"$tmp/relabel.txt"

echo "Mirrored ${created} new upstream issue(s); $((backlog - created)) left for later runs. upstream-closed: ${added} added, ${removed} removed.${DRY_RUN:+ (dry run, nothing written)}"
