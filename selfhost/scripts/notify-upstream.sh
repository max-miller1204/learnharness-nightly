#!/usr/bin/env bash
# Tell upstream, once, that a hand-picked item is fixed or merged in this fork
# (also used by .github/workflows/notify-upstream.yml). Design:
# docs/specs/upstream-handpicked.md.
#
#   selfhost/scripts/notify-upstream.sh find <merge commit SHA | fork PR>
#   selfhost/scripts/notify-upstream.sh <fork PR>
#
# A fork PR names the upstream items it fixes or imports in `Upstream:` lines
# at the top of its body (see upstream-refs.jq); the PR import writes one.
#
# `find` is read-only. It prints `pr=<M>` and `count=<items>` for the PR merged
# into main by that commit (or that PR, if it's merged into main), and `pr=`
# and `count=0` when there's none.
#
# With a fork PR number, for each declared upstream item it posts one short
# comment on the upstream issue or PR, from the token's account (the owner's),
# with a hidden marker so it never posts twice for the same item. Then it adds
# an `Upstream link: <URL>` line to the fork PR body (which makes the "mentioned
# this" entry on upstream's timeline) and leaves a receipt comment on the fork
# PR. An item is skipped unless the owner picked it (a fork bot mirror of the
# issue, or a fork bot PR from `upstream-pr/<N>`), and when upstream already
# merged the PR or closed the issue as completed.
#
# Writes only from the workflow (GITHUB_ACTIONS=true). Locally, run it with
# DRY_RUN=1 and your `gh` login: it prints the exact comment, the body edit and
# the receipt, and whether it would post or skip. BODY_FILE=<file> (dry run
# only) stands in for the PR body.
set -euo pipefail

FORK_BOT_LOGIN="${FORK_BOT_LOGIN:-learnharness-nightly-bot[bot]}"
MARKER="<!-- learnharness-nightly-notice -->"
DRY_RUN="${DRY_RUN:-}"
BODY_FILE="${BODY_FILE:-}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

mode="notify"
if [ "${1:-}" = find ]; then
	mode="find"
	shift
fi
TARGET="${1:?usage: notify-upstream.sh [find] <fork PR | merge commit SHA (find only)>}"
if [ "$mode" = notify ]; then
	[[ "$TARGET" =~ ^[0-9]+$ ]] || { echo "Fork PR number must be numeric" >&2; exit 1; }
	if [ -z "$DRY_RUN" ] && [ "${GITHUB_ACTIONS:-}" != true ]; then
		echo "Only the Notify upstream workflow posts upstream; run locally with DRY_RUN=1." >&2
		exit 1
	fi
	if [ -n "$BODY_FILE" ] && [ -z "$DRY_RUN" ]; then
		echo "BODY_FILE is for dry runs only." >&2
		exit 1
	fi
else
	[[ "$TARGET" =~ ^[0-9]+$ || "$TARGET" =~ ^[0-9a-f]{40}$ ]] || { echo "Give a fork PR number or a full commit SHA" >&2; exit 1; }
fi
UPSTREAM_REPO="${UPSTREAM_REPO:-amosblomqvist/learnharness}"
FORK_REPO="${FORK_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Every page of a list endpoint as one JSON array.
list() { gh api --paginate "$1" | jq -s 'add // []'; }

write() {
	if [ -n "$DRY_RUN" ]; then
		echo "DRY_RUN: $*"
	else
		"$@"
	fi
}

# The fork PR, or `null` when it isn't merged into main.
if [[ "$TARGET" =~ ^[0-9]+$ ]]; then
	gh api "repos/${FORK_REPO}/pulls/${TARGET}" | jq 'if .merged_at != null and .base.ref == "main" then . else null end' >"$tmp/pr.json"
else
	gh api "repos/${FORK_REPO}/commits/${TARGET}/pulls" |
		jq --arg sha "$TARGET" '[.[] | select(.merged_at != null and .base.ref == "main" and .merge_commit_sha == $sha)][0] // null' >"$tmp/pr.json"
fi

if [ "$(jq -r 'type' "$tmp/pr.json")" != object ]; then
	if [ "$mode" = find ]; then
		printf 'pr=\ncount=0\n'
	else
		echo "Fork PR #${TARGET} isn't merged into main; nothing to do."
	fi
	exit 0
fi
pr=$(jq -r .number "$tmp/pr.json")
pr_url=$(jq -r .html_url "$tmp/pr.json")
if [ -n "$BODY_FILE" ]; then
	cat "$BODY_FILE" >"$tmp/body.txt"
else
	jq -j '.body // ""' "$tmp/pr.json" >"$tmp/body.txt"
fi
jq -Rs -L "$here" 'include "upstream-refs"; upstream_refs' "$tmp/body.txt" >"$tmp/refs.json"
jq -Rs -L "$here" --arg repo "$UPSTREAM_REPO" 'include "upstream-refs"; upstream_numbers($repo) | .[]' "$tmp/body.txt" >"$tmp/numbers.txt"
jq -r --arg repo "$UPSTREAM_REPO" '.[] | select(.repo == null or (.repo | ascii_downcase) != ($repo | ascii_downcase)) | .line' "$tmp/refs.json" >"$tmp/ignored.txt"
while IFS= read -r line; do
	echo "Ignoring \"${line}\": not a reference to ${UPSTREAM_REPO}." >&2
done <"$tmp/ignored.txt"
count=$(wc -l <"$tmp/numbers.txt" | tr -d ' ')

if [ "$mode" = find ]; then
	echo "Fork PR #${pr} declares ${count} upstream item(s)." >&2
	printf 'pr=%s\ncount=%s\n' "$pr" "$count"
	exit 0
fi
if [ "$count" = 0 ]; then
	echo "Fork PR #${pr} has no Upstream: line for ${UPSTREAM_REPO}; nothing to do."
	exit 0
fi

me=$(gh api user | jq -r .login)
fork_owner=${FORK_REPO%%/*}
# Picked issues: the upstream numbers of the fork bot's mirrors.
creator=$(jq -rn --arg s "$FORK_BOT_LOGIN" '$s | @uri')
list "repos/${FORK_REPO}/issues?state=all&creator=${creator}&per_page=100" |
	jq --arg prefix "<!-- upstream-issue: ${UPSTREAM_REPO}#" --arg bot "${FORK_BOT_LOGIN}" '[.[] | select(.pull_request == null and .user.login == $bot)
		| ((.body // "") | split("\n")[0] | rtrimstr("\r")) as $first
		| select($first | startswith($prefix))
		| $first | ltrimstr($prefix) | rtrimstr(" -->") | tonumber? // empty]' >"$tmp/mirrored.json"

failed=0
posted=0
: >"$tmp/links.txt"
: >"$tmp/receipt.txt"
while IFS= read -r n <&3; do
	ref="${UPSTREAM_REPO}#${n}"
	if ! gh api "repos/${UPSTREAM_REPO}/issues/${n}" >"$tmp/item.json"; then
		echo "Couldn't read ${ref}." >&2
		echo "- \`${ref}\`: failed, couldn't read it upstream." >>"$tmp/receipt.txt"
		failed=1
		continue
	fi
	is_pr=$(jq -r '.pull_request != null' "$tmp/item.json")
	item_url=$(jq -r .html_url "$tmp/item.json")
	if [ "$is_pr" = true ]; then
		text="This PR is merged into the LearnHarness nightly fork (${FORK_REPO}): ${pr_url}"
	else
		text="This is fixed in the LearnHarness nightly fork (${FORK_REPO}): ${pr_url}"
	fi
	printf '%s\n\n%s\n' "$text" "$MARKER" >"$tmp/comment.md"
	if [ -n "$DRY_RUN" ]; then
		echo "Comment for ${ref} (${item_url}):"
		sed 's/^/    /' "$tmp/comment.md"
	fi

	# Picked by the owner?
	if [ "$is_pr" = true ]; then
		list "repos/${FORK_REPO}/pulls?state=all&head=${fork_owner}:upstream-pr/${n}&per_page=100" |
			jq --arg bot "$FORK_BOT_LOGIN" --arg head "upstream-pr/${n}" --arg fork "$FORK_REPO" \
				'any(.[]; .user.login == $bot and .head.ref == $head and .head.repo.full_name == $fork)' >"$tmp/picked"
		why_not="not picked: no fork bot PR from upstream-pr/${n}"
	else
		jq --argjson n "$n" 'index($n) != null' "$tmp/mirrored.json" >"$tmp/picked"
		why_not="not picked: no fork bot mirror of it"
	fi
	if [ "$(cat "$tmp/picked")" != true ]; then
		echo "Skipping ${ref}: ${why_not}."
		echo "- \`${ref}\`: skipped, ${why_not}." >>"$tmp/receipt.txt"
		continue
	fi

	# Already done upstream?
	done_upstream=""
	if [ "$is_pr" = true ]; then
		gh api "repos/${UPSTREAM_REPO}/pulls/${n}" >"$tmp/upstream-pr.json"
		[ "$(jq -r .merged "$tmp/upstream-pr.json")" = true ] && done_upstream="upstream already merged it"
	elif [ "$(jq -r '.state + "/" + (.state_reason // "")' "$tmp/item.json")" = closed/completed ]; then
		done_upstream="upstream already closed it as completed"
	fi
	if [ -n "$done_upstream" ]; then
		echo "Skipping ${ref}: ${done_upstream}."
		echo "- \`${ref}\`: skipped, ${done_upstream}." >>"$tmp/receipt.txt"
		continue
	fi

	# Told before? Once per upstream item, whichever fork PR it was for.
	list "repos/${UPSTREAM_REPO}/issues/${n}/comments?per_page=100" |
		jq -r --arg me "$me" --arg marker "$MARKER" '[.[] | select(.user.login == $me and ((.body // "") | contains($marker)))][0].html_url // ""' >"$tmp/earlier"
	earlier=$(cat "$tmp/earlier")
	if [ -n "$earlier" ]; then
		echo "Already told ${ref}: ${earlier}"
		echo "- \`${ref}\`: already told upstream earlier (\`${earlier}\`)." >>"$tmp/receipt.txt"
		echo "$item_url" >>"$tmp/links.txt"
		continue
	fi

	if [ -n "$DRY_RUN" ]; then
		echo "DRY_RUN: would post that comment on ${ref} as ${me}."
		comment_url="(the new comment's URL)"
	elif ! comment_url=$(jq -Rs '{body: .}' "$tmp/comment.md" | gh api -X POST --input - "repos/${UPSTREAM_REPO}/issues/${n}/comments" | jq -r .html_url); then
		echo "Couldn't post on ${ref} (locked, or the token can't write there)." >&2
		echo "- \`${ref}\`: failed to post (locked, or the token can't write there)." >>"$tmp/receipt.txt"
		failed=1
		continue
	fi
	[ -n "$DRY_RUN" ] || echo "Posted on ${ref}: ${comment_url}"
	echo "- \`${ref}\`: posted \`${comment_url}\`." >>"$tmp/receipt.txt"
	echo "$item_url" >>"$tmp/links.txt"
	posted=$((posted + 1))
done 3<"$tmp/numbers.txt"

# The link at merge: one `Upstream link:` line per item told, unless already there.
# $(...) drops the body's trailing newlines, so the links follow one blank line.
printf '%s' "$(cat "$tmp/body.txt")" >"$tmp/new-body.txt"
added_links=0
while IFS= read -r link; do
	if ! tr -d '\r' <"$tmp/body.txt" | grep -qxF "Upstream link: ${link}"; then
		if [ "$added_links" = 0 ]; then
			[ -s "$tmp/new-body.txt" ] && printf '\n\n' >>"$tmp/new-body.txt"
		else
			printf '\n' >>"$tmp/new-body.txt"
		fi
		printf 'Upstream link: %s' "$link" >>"$tmp/new-body.txt"
		added_links=$((added_links + 1))
	fi
done <"$tmp/links.txt"
if [ "$added_links" -gt 0 ]; then
	printf '\n' >>"$tmp/new-body.txt"
	write gh pr edit "$pr" -R "$FORK_REPO" --body-file "$tmp/new-body.txt"
	if [ -n "$DRY_RUN" ]; then
		echo "New fork PR body:"
		sed 's/^/    /' "$tmp/new-body.txt"
	fi
fi

if [ -s "$tmp/receipt.txt" ]; then
	{
		echo "Upstream notice for this merge (\`notify-upstream.yml\`):"
		echo
		cat "$tmp/receipt.txt"
	} >"$tmp/receipt.md"
	write gh pr comment "$pr" -R "$FORK_REPO" --body-file "$tmp/receipt.md"
	if [ -n "$DRY_RUN" ]; then
		echo "Receipt comment on fork PR #${pr}:"
		sed 's/^/    /' "$tmp/receipt.md"
	fi
fi

echo "Fork PR #${pr}: ${posted} upstream notice(s) posted.${DRY_RUN:+ (dry run, nothing written)}"
exit "$failed"
