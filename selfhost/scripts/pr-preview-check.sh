#!/usr/bin/env bash
# Decides whether a finished PR preview build is published, and gathers its
# files (docs/specs/pr-previews.md). Run by pr-preview-publish.yml, main's
# copy, on workflow_run. The build ran PR code, so everything it left is
# data: nothing from it is executed, and nothing it says is trusted without
# checking it against the GitHub API.
#
# Env: GH_REPO, OWNER (repository owner), RUN_ID, RUN_NUMBER, RUN_CREATED_AT,
# HEAD_SHA, ACTOR (the build run's triggering actor), FILES (download dir),
# OUT (publish dir), GITHUB_OUTPUT. Writes publish=true|false and, when
# true, pr, version, labeled and by_owner. Exit 1 only for a build that
# left malformed files.
set -euo pipefail

skip() { echo "::notice::No preview published: $*"; echo "publish=false" >> "$GITHUB_OUTPUT"; exit 0; }
bad() { echo "::error::$*"; exit 1; }

[[ "$ACTOR" =~ ^[A-Za-z0-9-]+(\[bot\])?$ ]] || skip "unexpected actor name."
# A build that skipped its jobs leaves no artifacts; that's not an error.
mkdir -p "$FILES/meta"
gh run download "$RUN_ID" -n preview-meta -D "$FILES/meta" >/dev/null 2>&1 || skip "the build left no PR number (it built nothing)."
pr=$(head -c 16 "$FILES/meta/pr" 2>/dev/null | tr -d '\n' || true)
[[ "$pr" =~ ^[1-9][0-9]{0,8}$ ]] || bad "The build named no valid PR number."

info=$(gh api "repos/$GH_REPO/pulls/$pr" --jq '[.state, .head.sha, .user.login, ([.labels[].name] | index("preview") != null)] | @tsv')
IFS=$'\t' read -r state head author labeled <<<"$info"
[ "$state" = open ] || skip "PR #$pr is $state."
[ "$head" = "$HEAD_SHA" ] || skip "PR #$pr moved on to $head; this build is of $HEAD_SHA."
perm=$(gh api "repos/$GH_REPO/collaborators/$ACTOR/permission" --jq .permission 2>/dev/null || echo none)
case "$perm" in admin|write) ;; *) skip "the build was started by $ACTOR, who has no write access." ;; esac

by_owner=false
if [ "$author" = "$OWNER" ]; then
  by_owner=true
else
  [ "$labeled" = true ] || skip "PR #$pr is by $author and has no \`preview\` label."
  # The label approves the commit that was the head when it was added. So
  # the run must be the one adding it started: the same person added
  # `preview` at most 60 seconds before the run was created. A run started
  # later by any other action (an edit, another label, an assignment, which
  # a fork's own copy of pr-preview.yml can listen to) is refused, even when
  # the label is still on and the head has moved to an unread commit.
  created=$(date -u -d "$RUN_CREATED_AT" +%s)
  started_by_label=false
  while read -r at; do
    [ -n "$at" ] || continue
    delta=$(( created - $(date -u -d "$at" +%s) ))
    if [ "$delta" -ge -5 ] && [ "$delta" -le 60 ]; then started_by_label=true; fi
  done < <(gh api --paginate "repos/$GH_REPO/issues/$pr/events" \
    --jq ".[] | select(.event == \"labeled\" and .label.name == \"preview\" and .actor.login == \"$ACTOR\") | .created_at")
  [ "$started_by_label" = true ] || skip "this build of PR #$pr wasn't started by $ACTOR adding the \`preview\` label. Add it again to build the current head."
fi

# Files are data: exact names, one version for both arches, the build's run
# number, checksums computed here. Downloaded only once the build counts.
gh run download "$RUN_ID" -p 'selfhost-*' -D "$FILES" >/dev/null
mkdir -p "$OUT"
version=""
for arch in linux-x64 linux-arm64; do
  shopt -s nullglob
  found=("$FILES/selfhost-$arch"/learnharness-*-"$arch".tar.gz)
  shopt -u nullglob
  [ "${#found[@]}" = 1 ] || bad "Expected one $arch archive, found ${#found[@]}."
  name=$(basename "${found[0]}")
  [[ "$name" =~ ^learnharness-([0-9]+\.[0-9]+\.[0-9]+-preview\.[0-9]{8}\.([0-9]+))-$arch\.tar\.gz$ ]] || bad "Unexpected archive name $name."
  [ "${BASH_REMATCH[2]}" = "$RUN_NUMBER" ] || bad "$name is not from build run $RUN_NUMBER."
  [ -z "$version" ] || [ "$version" = "${BASH_REMATCH[1]}" ] || bad "The two arches have different versions."
  version=${BASH_REMATCH[1]}
  { [ -f "${found[0]}" ] && [ ! -L "${found[0]}" ]; } || bad "$name is not a regular file."
  cp "${found[0]}" "$OUT/$name"
  (cd "$OUT" && sha256sum "$name" > "$name.sha256")
done
{
  echo "publish=true"
  echo "pr=$pr"
  echo "version=$version"
  echo "labeled=$labeled"
  echo "by_owner=$by_owner"
} >> "$GITHUB_OUTPUT"
