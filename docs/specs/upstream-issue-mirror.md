# Upstream issue mirror

Status: approved by the owner on 2026-11-17.

Goal: roadmap item 13. A scheduled job copies upstream issues (`amosblomqvist/learnharness`) into the fork as fork issues, once each, and labels a mirror `upstream-closed` while its upstream issue is closed. Nothing ever pings upstream.

## Decided by the owner

1. Auto-mirror on a schedule. Each upstream issue is copied **once**: title, body and the comments that exist at copy time. Later upstream edits and comments are not synced.
2. Mirrors are fork issues labeled `upstream`. The copied text fires no @mentions and never pings upstream or adds "mentioned this" entries to upstream timelines.
3. When an upstream issue is closed, its mirror gets the `upstream-closed` label and stays open.
4. Authenticate with the shared `.github/actions/fork-bot-token` step. The App gains **Issues: Read and write**.
5. Backfill: the first runs copy the upstream issues that are **open** (315 today). The 78 already closed are skipped. Issues opened after today are always mirrored.
6. Hourly, at minute 47 (Upstream sync runs at minute 17).
7. Upstream's labels are copied at copy time (upstream uses only `bug`, `enhancement`, `question`, which all exist here). A label the fork lacks is skipped, never created. Not kept in sync later.
8. If upstream reopens an issue, the job removes `upstream-closed`, so the label always matches upstream's current state.
9. Upstream PRs are excluded (the issues API also returns PRs; they're filtered out). PRs come in through "Import upstream PR".

## Adopted from T3 Code (veto any)

T3 Code has no issue mirror, so little applies. One pattern does:

- **Managed labels** (T3's `issue-labels.yml`): each run makes sure `upstream` and `upstream-closed` exist with the color and description below, creating or updating them (`gh label create --force`).

## Proposed defaults (veto any)

These are small calls that follow this repo's existing upstream workflows.

| Topic | Proposal |
|---|---|
| Matching a mirror to its upstream issue | A hidden first line in the mirror body, `<!-- upstream-issue: amosblomqvist/learnharness#N -->`. Each run lists every fork issue (any state, any labels) and reads that marker. Removing the label or renaming the mirror doesn't cause a duplicate; deleting the marker line does. |
| Title | `[upstream issue N] <upstream title>`, like `[upstream PR N] <title>` for imported PRs. |
| Which issues count as new | An upstream issue with no mirror is copied if it's open, **or** if its number is above `792` (the newest today) even when already closed. So an issue opened and closed between two runs is still mirrored, arriving with `upstream-closed`. The `792` cutoff is a constant in the workflow. |
| Order and per-run cap | Oldest first (lowest number), at most **100** new mirrors per run, 1 second apart. The backfill of 315 takes 4 hourly runs. |
| Rate limits | Reads are about 15 calls per run plus one comments call per new mirror, far below the App's 5000 per hour. Writes stay under GitHub's secondary limits (80 per minute, 500 per hour) through the cap and the pause. Each mirror is a single create call with its labels, so a failure never leaves a half-made mirror. Any API error stops the run and fails it (a red run, GitHub emails the owner); the next run picks up where it stopped, because what's mirrored is read from the fork each time. |
| Overlapping runs | `concurrency: mirror-upstream-issues`, no cancel, so two runs never create the same mirror twice. |
| No pings | Same rules as the PR import. Upstream references are written as code (`` `amosblomqvist/learnharness#N` `` and the URL in backticks), authors as code (`` `login` ``), and the body and each comment sit in a `~~~~markdown` fenced block, where mentions, `#N` links and URLs don't fire. A copied line that could close the fence (up to 3 spaces, then `~~~~`) is indented to 4 spaces so it can't. |
| Body layout | Marker line; one credit line (upstream link, author, opened date, "copied once on <date>; later upstream edits and comments aren't synced"); the issue body in an open `<details>`; then the comments in a collapsed `<details>`, each headed by its author and date. |
| Size limit | GitHub caps an issue body at 65536 characters. If the mirror would pass 60000 bytes, comments are dropped from the end with a note "N more comments upstream"; if the body alone is too long it's cut with "Truncated; read the rest upstream". |
| Label colors | `upstream`: `1d76db`, "Mirrored from amosblomqvist/learnharness". `upstream-closed`: `cfd3d7`, "Closed upstream; this copy stays open". |
| Manual run | `workflow_dispatch` with an optional `issue` number: mirror just that upstream issue now (even an older closed one), then run the close-tracking pass. Without it, a dispatch does a normal run. |
| Local run | `selfhost/scripts/mirror-upstream-issues.sh [issue]` with your `gh` login, like `import-upstream-pr.sh`. `DRY_RUN=1` prints what it would create and label without writing. |
| Turning on Issues | Issues are **disabled** on the fork today. After approval I run `gh repo edit max-miller1204/learnharness-nightly --enable-issues` with your login (or you tick Settings → General → Features → Issues). |
| Notifications | The backfill creates about 315 issues. If you watch the repo, GitHub sends a notification for each (bot-created issues notify watchers). Expect a burst over 4 hours. |

## Design

### `.github/workflows/mirror-upstream-issues.yml` (new)

```yaml
on:
  schedule:
    - cron: "47 * * * *"
  workflow_dispatch:
    inputs:
      issue: { description: "Mirror only this upstream issue number (optional)", required: false, type: string }
permissions:
  contents: read
concurrency: { group: mirror-upstream-issues, cancel-in-progress: false }
env:
  UPSTREAM_REPO: amosblomqvist/learnharness
jobs:
  mirror:
    if: github.repository == 'max-miller1204/learnharness-nightly'
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps: checkout (persist-credentials false), fork-bot-token, run the script
```

### `selfhost/scripts/mirror-upstream-issues.sh` (new, bash + `gh` + `jq`)

1. Ensure the two labels exist.
2. List upstream issues (state all, PRs filtered out) and fork issues (state all), each in one paginated call.
3. Build the map upstream number → fork mirror (number, labels) from the markers.
4. **New mirrors:** pick unmirrored upstream issues that are open or above the cutoff (or only the dispatched `issue`), oldest first, up to 100. For each: fetch its comments, render the body with `jq`, create the fork issue with `upstream`, upstream's labels that exist here, and `upstream-closed` if it's already closed.
5. **Close tracking:** for every existing mirror, add `upstream-closed` when upstream is closed and the label is missing; remove it when upstream is open and the label is present. Fork open or closed state is never changed.
6. Print a summary: created, labeled, unlabeled, remaining backlog.

### Docs

- `docs/fork-workflow.md`: a "Mirroring upstream issues" section (what it does, how to run it, matching marker, don't delete the first line), Issues in the App's permissions (setup step 4 and "The token can..."), "Turn on Issues" in one-time settings, and the new files in "What lives where".
- `docs/fork-roadmap.md`: item 13 is built, so remove its index row and section, mention the mirror in the baseline list, and drop 13 from "Why this order". Its unbuilt ideas: the weekly digest and per-issue manual import are covered by the mirror and dropped; "offer fork fixes back upstream as PRs" moves to a new Later item 28, "Offering fork fixes upstream", with no design yet.
- `docs/specs/github-app.md` is history and stays unchanged.

## Owner steps

1. Approve this spec.
2. Add the Issues permission to the fork bot App: open <https://github.com/settings/apps>, **Edit** the fork bot App, **Permissions & events**, under **Repository permissions** set **Issues** to **Read and write**, click **Save changes**. Then open <https://github.com/settings/installations>, **Configure** the fork bot installation, and accept the updated permissions (GitHub shows a "review request" banner). Tell me when done.

## Verification

1. Local `DRY_RUN=1` against real upstream: the counts match (315 open to backfill), and a rendered body with mentions, `#N`, URLs and a tilde fence in it stays inside its code block.
2. After the owner's step 2: dispatch from this PR's branch with `issue: 792` (open): one mirror appears with `upstream` and its upstream labels, no mentions. Kept as a real mirror.
3. Dispatch with `issue: 751` (closed upstream, below the cutoff, so test-only): the mirror arrives with `upstream-closed`. Remove that label by hand and dispatch a normal run: the label comes back (the "later closed" path). Add `upstream-closed` by hand to the #792 mirror and run again: it's removed (the reopen path). Then delete the #751 test mirror.
4. After review fixes, one full dispatch from the branch: 100 open issues mirrored oldest first, no duplicates on a second run.
5. CI `Check` green; one independent review round; a `prove-learnharness` run (CI and docs only, so no app surface; prove says so).

## Out of scope

Syncing later upstream edits or comments, mirroring PRs, sending anything upstream, creating labels the fork lacks, offering fork fixes upstream (item 28).
