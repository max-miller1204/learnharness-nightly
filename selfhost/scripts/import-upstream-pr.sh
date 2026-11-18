#!/usr/bin/env bash
# Import one upstream PR into this fork for review (also used by
# .github/workflows/import-upstream-pr.yml).
#
#   selfhost/scripts/import-upstream-pr.sh <upstream PR number>
#
# Pushes the PR's exact head commits to `upstream-pr/<N>` (unchanged, so
# commit IDs match upstream) and opens or updates a fork PR into main that
# names the original and credits its author. Uses your `gh` login locally,
# the fork bot App token in CI. The body links the upstream PR by URL, so its
# timeline shows a "mentioned this" entry pointing here
# (docs/specs/simplify-upstream-intake.md). The author is written as code and
# the copied description sits in a code block it can't close (see fence.jq), so
# the import @mentions no one.
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
# The fork's reviewed upstream: what the upstream sync last pushed to
# upstream-main (it pauses on unreviewed upstream .github/ changes).
git fetch --no-tags "https://github.com/${FORK_REPO}.git" \
	"+refs/heads/upstream-main:refs/remotes/upstream-reviewed/main"
# Checked on the exact commit pushed below: the PR's own .github/ changes, and
# any other way the pushed branch's .github/ differs from upstream-main (say,
# upstream changed it on main after the sync paused). The branch's workflows
# run here as soon as it's pushed.
github_changes=$(git diff --no-renames --name-only "refs/remotes/upstream-base/${N}...refs/remotes/upstream-pr/${N}" -- .github)
unreviewed=$(git diff --no-renames --name-only "refs/remotes/upstream-reviewed/main" "refs/remotes/upstream-pr/${N}" -- .github)
if { [ -n "$github_changes" ] || [ -n "$unreviewed" ]; } && [ "${ALLOW_GITHUB_CHANGES:-}" != 1 ] && [ "${ALLOW_GITHUB_CHANGES:-}" != true ]; then
	{
		if [ -n "$github_changes" ]; then
			echo "Upstream PR ${N} changes .github/:"
			sed 's/^/  /' <<<"$github_changes"
		fi
		if [ -n "$unreviewed" ]; then
			echo "Upstream PR ${N}'s branch has a .github/ that differs from upstream-main (upstream changes the sync hasn't taken yet, or ones its older base lacks):"
			sed 's/^/  /' <<<"$unreviewed"
		fi
		echo "Its workflows would run here with this repository's secrets. Read its diff (${url}/files), then re-run with allow_github_changes (ALLOW_GITHUB_CHANGES=1 locally)."
	} >&2
	exit 1
fi
git push --force origin "refs/remotes/upstream-pr/${N}:refs/heads/${BRANCH}"

{
	echo "Imported from ${url} by \`${author}\` (upstream state: ${state}$([ "$merged" = "true" ] && echo ", merged"))."
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
