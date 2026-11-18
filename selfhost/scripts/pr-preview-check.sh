#!/usr/bin/env bash
# Decides whether a finished PR preview build is published, and gathers its
# files (docs/specs/pr-previews.md). Run by pr-preview-publish.yml, main's
# copy, on workflow_run. The build ran PR code, so everything it left is
# data: nothing from it is executed, and nothing it says is trusted without
# checking it against the GitHub API.
#
# --identify finds the PR number for per-PR publish serialization.
# --confirm checks the live head and consumes the same approval immediately
# before publishing. The default mode checks authorization and gathers files.
set -euo pipefail

skip() { echo "::notice::No preview published: $*"; echo "publish=false" >> "$GITHUB_OUTPUT"; exit 0; }
bad() { echo "::error::$*"; exit 1; }

read_pr() {
  local info
  info=$(gh api "repos/$GH_REPO/pulls/$pr" --jq '[.state, .head.sha, .user.login, ([.labels[].name] | index("preview") != null)] | @tsv')
  IFS=$'\t' read -r state head author labeled <<<"$info"
  [ "$state" = open ] || skip "PR #$pr is $state."
  [ "$head" = "$HEAD_SHA" ] || skip "PR #$pr moved on to $head; this build is of $HEAD_SHA."
}

current_label() {
  gh api --paginate "repos/$GH_REPO/issues/$pr/events" \
    --jq '.[] | select((.event == "labeled" or .event == "unlabeled") and .label.name == "preview") | [.id, .event, .actor.login, .created_at] | @tsv' |
    sort -k1,1n | tail -n 1
}

owner_label() {
  local event labeler latest
  [ "$labeled" = true ] || skip "PR #$pr has no \`preview\` label."
  latest=$(current_label) || bad "Could not read the current approval for PR #$pr."
  IFS=$'\t' read -r label_id event labeler label_at <<<"$latest"
  [ "$event" = labeled ] && [ "$labeler" = "$OWNER" ] || skip "The current preview label was not added by $OWNER."
}

case "${1:-}" in
  --identify)
    mkdir -p "$FILES/meta"
    gh run download "$RUN_ID" -n preview-meta -D "$FILES/meta" >/dev/null 2>&1 || skip "the build left no PR number (it built nothing)."
    pr=$(head -c 16 "$FILES/meta/pr" 2>/dev/null | tr -d '\n' || true)
    [[ "$pr" =~ ^[1-9][0-9]{0,8}$ ]] || bad "The build named no valid PR number."
    echo "pr=$pr" >> "$GITHUB_OUTPUT"
    exit 0
    ;;
  --confirm)
    pr=$PR
    read_pr
    if [ -n "$APPROVAL_LABEL" ]; then
      owner_label
      [ "$label_id" = "$APPROVAL_LABEL" ] || skip "PR #$pr has a different preview label approval."
      gh api -X DELETE "repos/$GH_REPO/issues/$pr/labels/preview" >/dev/null
      read_pr
    fi
    echo "publish=true" >> "$GITHUB_OUTPUT"
    exit 0
    ;;
esac

pr=$PR
[[ "$ACTOR" =~ ^[A-Za-z0-9-]+(\[bot\])?$ ]] || skip "unexpected actor name."
read_pr
perm=$(gh api "repos/$GH_REPO/collaborators/$ACTOR/permission" --jq .permission 2>/dev/null || echo none)
case "$perm" in admin|write) ;; *) skip "the build was started by $ACTOR, who has no write access." ;; esac

by_owner=false
approval_label=""
if [ "$author" = "$OWNER" ]; then
  by_owner=true
else
  [ "$ACTOR" = "$OWNER" ] || skip "Only $OWNER can request an outside PR preview."
  owner_label
  label_time=$(date -u -d "$label_at" +%s)
  # Match the current label application. Timing only identifies the request;
  # the commit must be recorded by the trusted, label-only workflow.
  matches_label() {
    local delta
    delta=$(( $(date -u -d "$1" +%s) - label_time ))
    [ "$delta" -ge -5 ] && [ "$delta" -le 60 ]
  }
  matches_label "$RUN_CREATED_AT" || skip "This build did not run for the current preview label."
  approval_name="preview-approval-$pr-$HEAD_SHA"
  runs=$(gh api --paginate -X GET "repos/$GH_REPO/actions/artifacts" -f name="$approval_name" \
    --jq '.artifacts[] | select(.expired == false) | .workflow_run.id')
  while read -r run; do
    [[ "$run" =~ ^[1-9][0-9]*$ ]] || continue
    info=$(gh api "repos/$GH_REPO/actions/runs/$run" \
      --jq '[.event, (.path | split("@")[0]), .actor.login, .conclusion, .created_at] | @tsv')
    IFS=$'\t' read -r event workflow approver conclusion created_at <<<"$info"
    if [ "$event" = pull_request_target ] && [ "$workflow" = .github/workflows/pr-preview-approval.yml ] &&
      [ "$approver" = "$OWNER" ] && [ "$conclusion" = success ] && matches_label "$created_at"; then
      approval_label=$label_id
      break
    fi
  done <<<"$runs"
  [ -n "$approval_label" ] || skip "No trusted owner approval for PR #$pr at $HEAD_SHA."
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
  echo "approval_label=$approval_label"
  echo "by_owner=$by_owner"
} >> "$GITHUB_OUTPUT"
