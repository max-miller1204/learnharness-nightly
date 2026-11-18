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
# copied description sits in a code block it can't close (see fence.jq), so the
# import never pings anyone or adds a "mentioned this" entry to upstream's PR
# timeline. The body's first line, `Upstream: `<repo>#<N>``, tells
# notify-upstream.sh which upstream PR to tell about this one once it merges
# (docs/specs/upstream-handpicked.md).
#
# An upstream PR that changes anything under .github/ is refused unless
# ALLOW_GITHUB_CHANGES=1 (the workflow's allow_github_changes checkbox): the
# pushed branch's own workflows would run here with this repository's secrets.
# Read its diff first.
set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-amosblomqvist/learnharness}"
FORK_REPO="${FORK_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
N="${1:?usage: import-upstream-pr.sh <upstream PR number>}"
[[ "$N" =~ ^[0-9]+$ ]] || { echo "PR number must be numeric" >&2; exit 1; }
BRANCH="upstream-pr/$N"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

info=$(gh api "repos/${UPSTREAM_REPO}/pulls/${N}")
title=$(jq -r .title <<<"$info")
author=$(jq -r .user.login <<<"$info")
url=$(jq -r .html_url <<<"$info")
state=$(jq -r .state <<<"$info")
merged=$(jq -r .merged <<<"$info")
base_ref=$(jq -r .base.ref <<<"$info")
description=$(jq -r -L "$here" 'include "fence"; .body | fence("(none)")' <<<"$info")

git fetch --no-tags "https://github.com/${UPSTREAM_REPO}.git" \
	"+refs/pull/${N}/head:refs/remotes/upstream-pr/${N}" \
	"+refs/heads/${base_ref}:refs/remotes/upstream-base/${N}"
# What the PR changes, checked on the exact commit pushed below. This covers
# the PR's own changes only: the rest of the branch's .github/ is upstream's at
# the PR's base, which today runs nothing with secrets on a branch push or PR.
github_changes=$(git diff --no-renames --name-only "refs/remotes/upstream-base/${N}...refs/remotes/upstream-pr/${N}" -- .github)
if [ -n "$github_changes" ] && [ "${ALLOW_GITHUB_CHANGES:-}" != 1 ] && [ "${ALLOW_GITHUB_CHANGES:-}" != true ]; then
	{
		echo "Upstream PR ${N} changes .github/:"
		sed 's/^/  /' <<<"$github_changes"
		echo "Its workflows would run here with this repository's secrets. Read its diff (${url}/files), then re-run with allow_github_changes (ALLOW_GITHUB_CHANGES=1 locally)."
	} >&2
	exit 1
fi
git push --force origin "refs/remotes/upstream-pr/${N}:refs/heads/${BRANCH}"

{
	echo "Upstream: \`${UPSTREAM_REPO}#${N}\`"
	echo
	echo "Imported from \`${UPSTREAM_REPO}#${N}\` (\`${url}\`) by \`${author}\` (upstream state: ${state}$([ "$merged" = "true" ] && echo ", merged"))."
	echo
	echo "The branch \`${BRANCH}\` holds the PR's exact commits. Merge with **Create a merge commit**, never squash, so a later upstream version of this work merges cleanly. Re-run the import to pick up new upstream pushes."
	echo
	echo "<details><summary>Original description</summary>"
	echo
	printf '%s\n\n' "$description"
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
