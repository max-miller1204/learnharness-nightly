#!/usr/bin/env bash
# Import one upstream PR into this fork for review (also used by
# .github/workflows/import-upstream-pr.yml).
#
#   selfhost/scripts/import-upstream-pr.sh <upstream PR number>
#
# Pushes the PR's exact head commits to `upstream-pr/<N>` (unchanged, so
# commit IDs match upstream) and opens or updates a fork PR into main that
# names the original and credits its author. Uses your `gh` login locally,
# the fork bot App token in CI. Upstream references are written as code and the
# copied description sits in a code block, so the import never pings anyone
# or adds a "mentioned this" entry to upstream's PR timeline.
set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-amosblomqvist/learnharness}"
FORK_REPO="${FORK_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
N="${1:?usage: import-upstream-pr.sh <upstream PR number>}"
[[ "$N" =~ ^[0-9]+$ ]] || { echo "PR number must be numeric" >&2; exit 1; }
BRANCH="upstream-pr/$N"

info=$(gh api "repos/${UPSTREAM_REPO}/pulls/${N}")
title=$(jq -r .title <<<"$info")
author=$(jq -r .user.login <<<"$info")
url=$(jq -r .html_url <<<"$info")
state=$(jq -r .state <<<"$info")
merged=$(jq -r .merged <<<"$info")
body=$(jq -r '.body // ""' <<<"$info")

git fetch --no-tags "https://github.com/${UPSTREAM_REPO}.git" "refs/pull/${N}/head:refs/remotes/upstream-pr/${N}"
git push --force origin "refs/remotes/upstream-pr/${N}:refs/heads/${BRANCH}"

{
	echo "Imported from \`${UPSTREAM_REPO}#${N}\` (\`${url}\`) by \`${author}\` (upstream state: ${state}$([ "$merged" = "true" ] && echo ", merged"))."
	echo
	echo "The branch \`${BRANCH}\` holds the PR's exact commits. Merge with **Create a merge commit**, never squash, so a later upstream version of this work merges cleanly. Re-run the import to pick up new upstream pushes."
	echo
	echo "<details><summary>Original description</summary>"
	echo
	echo '~~~~markdown'
	if [ -n "$body" ]; then printf '%s\n' "$body" | sed 's/^~~~~/ ~~~~/'; else echo "(none)"; fi
	echo '~~~~'
	echo
	echo "</details>"
} > /tmp/import-pr-body.md

existing=$(gh pr list -R "$FORK_REPO" --head "$BRANCH" --base main --state open --json number --jq '.[0].number // ""')
pr_title="[upstream PR ${N}] ${title}"
if [ -n "$existing" ]; then
	gh pr edit "$existing" -R "$FORK_REPO" --title "$pr_title" --body-file /tmp/import-pr-body.md
	echo "Updated fork PR #${existing} from ${url}"
else
	gh pr create -R "$FORK_REPO" --head "$BRANCH" --base main --title "$pr_title" --body-file /tmp/import-pr-body.md
fi
