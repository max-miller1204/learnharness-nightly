# Hand-picked upstream issues and PRs

Status: approved by the owner on 2026-11-18. Builds on PR #132 (`docs/specs/fix-upstream-hardening.md`).

**Superseded in part by [simplify-upstream-intake.md](simplify-upstream-intake.md) (2026-11-17):** the merge-time comment (`notify-upstream.yml`, the `Upstream:` line, `UPSTREAM_COMMENT_TOKEN`, the `upstream-notify` environment) is gone. The import and the mirror link their upstream item by URL from the start instead. Hand-picking, the `.github/` import guard and the daily `upstream-closed` sync stay as described here.

Goal: rework roadmap item 13 (upstream intake, `docs/specs/upstream-issue-mirror.md`). Nothing from upstream (`amosblomqvist/learnharness`) is imported on its own any more. The owner picks each upstream issue or PR worth taking. When a fork PR that fixes or imports a picked item merges into `main`, upstream users can find it: the fork PR links the upstream item, and one short comment goes on the upstream item from the owner's account.

## Decided by the owner

1. **Hand-picked only**, issues and PRs. Picking an item means running its import: **Mirror upstream issues** with an `issue` number, or **Import upstream PR** with a PR number. The hourly backfill of new issues goes away. (Already done: the scheduled mirror is disabled and the 201 bot mirrors are deleted.)
2. **Discovery, at merge only.** This reverses the old "never ping upstream" rule on purpose, and only this far. When a fork PR that fixes a picked upstream issue, or imports a picked upstream PR, merges into the fork's `main`:
   - (a) the fork PR links the upstream item by full URL, so upstream's timeline shows a "mentioned this" entry;
   - (b) exactly one short, factual comment goes on the upstream item.

   Never at import time, never more than once per upstream item, never on an item the owner didn't pick, never an @mention.
3. **The comment comes from the owner's account** (`max-miller1204`), not the fork bot App (the App isn't installed upstream).
4. **The link appears at merge, not before** (owner's answer during this spec). Until merge, the fork PR names the upstream item as code (no link), so upstream sees nothing for a PR that is closed unmerged.
5. **Import guard** (owner's answer during this spec, after the secrets finding below): the PR import refuses an upstream PR whose own changes touch `.github/`, unless dispatched with a new `allow_github_changes` checkbox after reading its diff.

## Token (decision 3): what GitHub allows

From GitHub's docs ([managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)):

- Fine-grained PATs can't do this. The docs list as unsupported: "Using fine-grained personal access token to contribute to public repos where the user is not a member", and say "Only personal access tokens (classic) have write access for public repositories that are not owned by you."
- A classic PAT with **`public_repo`** is the narrowest scope that can comment on another owner's public repo ([scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps): "Limits access to public repositories", read/write). There's no comment-only scope.

**Recommendation:** a classic PAT, scope `public_repo` only, expiry 1 year, named "LearnHarness nightly upstream notice".

**Security trade-off.** That token can do almost anything you can do on every public repo you can write to, this fork included (push code, edit issues, comment anywhere). It lives in GitHub Actions, so anything that can read the secret can act as you. The main risk here: imported upstream PR branches (`upstream-pr/<N>`) hold an upstream author's code, and a same-repo PR's CI runs that PR's own workflow files with access to repository secrets. A plain repository secret could be read by a malicious upstream PR the moment it's imported. So the token goes in an **environment secret**, not a repository secret:

- Environment `upstream-notify`, deployment branches limited to `main` only. Only a job running on `main`'s own workflow files (reviewed and merged) can read it; a PR branch or an imported upstream branch can't.
- The secret is used in one step that runs one script; it's never printed.
- Leftover worth removing (separate from this work): the old `FORK_BOT_TOKEN` repository secret from before the App is still set. If it's still a live PAT, it has the same exposure. I'll list it in the owner steps.

Secret name: **`UPSTREAM_COMMENT_TOKEN`**.

## How a fork PR declares its upstream item (decision 4)

A line in the fork PR body:

```
Upstream: `amosblomqvist/learnharness#123`
```

- **Imported PRs** get it automatically: `import-upstream-pr.sh` writes it as the body's first line.
- **Fixes** for a picked issue: you (or an agent) add it by hand when opening the PR.
- Written in backticks so it's code: no link, no timeline entry upstream until merge (decision 4). The parser also accepts it without backticks, or as the upstream URL (`https://github.com/amosblomqvist/learnharness/issues/123` or `/pull/123`), but those forms link immediately, so docs say to use backticks.
- The lines must be at the **top** of the body: the script reads lines from the first one (leading blank lines skipped) and stops at the first line that isn't an `Upstream:` line. So an `Upstream:` line quoted inside an imported PR's copied description, or anywhere lower down, never counts.
- Several `Upstream:` lines are allowed (one PR fixing two picked issues); each item is handled on its own. References to any other repository are ignored.

## Repository secrets and imported PRs (finding, and the guard)

Checked while writing this spec, at the owner's request. Today an imported upstream PR **can** read every repository secret (`FORK_BOT_CLIENT_ID`, `FORK_BOT_PRIVATE_KEY`, `OPENROUTER_API_KEY`, `FORK_BOT_TOKEN`, `WEBSITE_DISPATCH_TOKEN`), if it adds or edits a file under `.github/workflows/`:

- The import pushes `upstream-pr/<N>` with the App token, and the App has Workflows: write, so the push is accepted and triggers that branch's own `on: push` workflows, which can name any repository secret.
- The fork PR is a same-repository PR, so its `pull_request` runs use the PR's own `ci.yml` and `pr-agent.yml`, again with repository secrets.

Untouched workflows don't expose them: CI references no secrets, and PR-Agent runs a pinned image that doesn't run repository code. So the guard (decision 5):

- `import-upstream-pr.sh` fetches the PR head and its upstream base branch first, then lists the files the PR changes (`git diff --name-only <base>...<head>`). If any is under `.github/`, it stops before pushing anything: "Upstream PR N changes .github/ (list). Read its diff, then re-run with allow_github_changes (ALLOW_GITHUB_CHANGES=1 locally)."
- The check runs on the exact commit it then pushes, so a push upstream between check and import can't slip past it.
- `import-upstream-pr.yml` gets a boolean input `allow_github_changes` (default off).

The rest goes to a follow-up hardening PR (listed in this PR's report): FORK_BOT_* into a `main`-only environment, deleting `FORK_BOT_TOKEN`, and the upstream sync, which pushes upstream `main` to `upstream-main` and so runs upstream's own workflow files there.

## Proposed defaults (veto any)

| Topic | Proposal |
|---|---|
| Scheduled job for `upstream-closed` | **Keep a light one, daily** (06:47 UTC), for hand-picked mirrors only. It creates nothing: it fetches each existing mirror's upstream issue (one call per mirror) and adds or removes `upstream-closed`, as today. The workflow is re-enabled when this merges. Without a number, a dispatch does just this pass. |
| What counts as "picked" | The `Upstream:` line alone isn't enough, so a typo can't comment on a random upstream item. An **issue** counts only if a fork bot mirror of it exists (the marker line, opened by the bot). A **PR** counts only if a fork PR from `upstream-pr/<N>` opened by the bot exists (any state), so a rework of an imported PR also counts. Anything else is skipped with a log line. |
| Mirroring one issue | `mirror-upstream-issues.sh <N>` fetches just that upstream issue (not the whole list) and mirrors it if it isn't mirrored yet. `NEW_AFTER`, `MAX_NEW` and the backlog logic are removed. |
| Trigger | New workflow `.github/workflows/notify-upstream.yml` on **push to `main`**, not `pull_request: closed`. A push runs on `ref: main`, which the environment's `main`-only rule needs (a `pull_request` event runs on `refs/pull/N/merge` and wouldn't get the secret). The pushed head commit is matched to its PR with `GET /repos/<fork>/commits/<sha>/pulls`, keeping only a PR with `merged_at` set, base `main` and `merge_commit_sha` equal to that commit. Works for squash and merge-commit merges. |
| Two jobs | `find` (no environment, `GITHUB_TOKEN` read-only) finds the merged PR and its `Upstream:` lines. `notify` (environment `upstream-notify`) runs only if there's at least one. So ordinary merges don't create a deployment record or touch the token. |
| Manual run | `workflow_dispatch` with a fork PR `number`: runs the notifier for that merged PR (for example after adding the token late). From `main` only (the environment rule). |
| Comment text, issue | `This is fixed in the LearnHarness nightly fork (max-miller1204/learnharness-nightly): https://github.com/max-miller1204/learnharness-nightly/pull/<M>` |
| Comment text, PR | `This PR is merged into the LearnHarness nightly fork (max-miller1204/learnharness-nightly): https://github.com/max-miller1204/learnharness-nightly/pull/<M>` |
| Once per item | Each comment ends with a hidden marker `<!-- learnharness-nightly-notice -->`. Before posting, the script reads the item's upstream comments; if one by the token's user already has the marker, it skips. The check is per upstream item, so a second fork PR for the same issue posts nothing. (If you delete that comment upstream, a later merge for the same item posts again.) |
| When upstream is already done | Skipped: an upstream issue closed as **completed**, or an upstream PR already **merged**. Still posted: open items, an issue closed as "not planned", a PR closed unmerged (a pointer to the fork is useful there). Locked upstream items: the post fails, the run logs it and goes on to the next item, and the run ends red. |
| Link at merge | After posting (or finding the earlier notice), the script edits the fork PR body once: it appends `Upstream link: <full upstream URL>` per item, unless that line is already there. That edit makes upstream's "mentioned this" entry. |
| Receipt in the fork | The script comments on the fork PR (as you): ``Posted the upstream notice: `<comment URL>` `` or ``Skipped `amosblomqvist/learnharness#N`: <reason>``. The URL is code so it doesn't add a second timeline entry. |
| Missing token | If the PR declares an upstream item and `UPSTREAM_COMMENT_TOKEN` is empty, the job fails with `::error::Add the UPSTREAM_COMMENT_TOKEN secret to the upstream-notify environment (docs/fork-workflow.md)`. After adding it, dispatch the workflow with the PR number. Merges without an `Upstream:` line never need it. |
| Expired token | GitHub rejects it; the run fails red and GitHub emails you. Renew it and re-dispatch. |
| No mentions | The comment is fixed text plus two URLs; no title or body is copied, so nothing can carry an @mention. |
| Local run | `selfhost/scripts/notify-upstream.sh <fork PR>` with your `gh` login. Like the mirror, it **writes only in the workflow** (`GITHUB_ACTIONS=true`); locally it needs `DRY_RUN=1`, and then prints, per item, the exact comment, the body edit, the receipt and whether it would post or skip (and why). `BODY_FILE=<file>` (dry run only) stands in for the PR body, so the dry run can be pointed at any merged PR. |
| Import body | `import-upstream-pr.sh` adds the `Upstream:` line as the first line. Everything else in the import stays as it is (references as code, the description in a fence). |
| Item 28 | Not covered. This tells upstream users that a fix exists in the fork. Item 28 is about sending the fix itself back upstream as a PR. Item 28 stays in the roadmap; its "Why" is updated to point at this spec. |

## Design

### `selfhost/scripts/notify-upstream.sh` (new, bash + `gh` + `jq`)

`notify-upstream.sh find <commit SHA | fork PR>` is read-only: it prints `pr=<M>` and `count=<items>` for the merged PR (none: `pr=` and `count=0`). The workflow's `find` job writes that to `GITHUB_OUTPUT`.

`notify-upstream.sh <fork PR>` notifies:

1. Read the fork PR. Stop (exit 0, log) unless it's merged into `main`.
2. Parse `Upstream:` lines (jq, from the body or `BODY_FILE`) into unique upstream numbers.
3. Read the token's login (`gh api user`).
4. Per number: read the upstream item; check it's picked; check it isn't already done upstream; check for an earlier notice. Then post the comment, add the `Upstream link:` line to the fork PR body if missing, and comment the receipt. Each write is `write ...` (prints instead under `DRY_RUN`).
5. Summary: posted, already there, skipped. Exit non-zero if any read or post failed. A failed read or post skips only that item (it's in the receipt); the others still get their comment, link and receipt, and a re-run is safe because of the marker.

Added after the review round: `find` with a SHA retries an empty commit-to-PR answer (4 tries, 10 seconds apart), since GitHub links a pushed commit to its PR asynchronously. The missing-token check lives in the script, so it's tested. The workflow's `concurrency` group is on the `notify` job only, so ordinary merges never take its one waiting slot. The mirror's close tracking skips an unreadable upstream issue (deleted upstream, say), relabels the rest, then fails the run.

### `.github/workflows/notify-upstream.yml` (new)

```yaml
on:
  push: { branches: [main] }
  workflow_dispatch:
    inputs:
      pr: { description: "Merged fork PR number", required: true, type: number }
permissions: { contents: read }
concurrency: { group: notify-upstream, cancel-in-progress: false }
jobs:
  find:     # GITHUB_TOKEN, pull-requests: read; outputs pr + whether it declares upstream items
  notify:   # needs find, if declared; environment: upstream-notify;
            # checkout (persist-credentials false), then
            # GH_TOKEN: secrets.UPSTREAM_COMMENT_TOKEN, run notify-upstream.sh
```

### Changed

- `mirror-upstream-issues.sh`: single-issue mirror by direct fetch; close tracking per mirror; backfill removed.
- `mirror-upstream-issues.yml`: daily schedule, `issue` input kept, `NEW_AFTER`/`MAX_NEW` removed; re-enabled after merge (`gh workflow enable`).
- `import-upstream-pr.sh`: the `Upstream:` first line, and the `.github/` guard (decision 5); `import-upstream-pr.yml` gets the `allow_github_changes` input.
- `selfhost/scripts/upstream-refs.jq` (new): the `Upstream:` line parser, shared by `find` and the notifier.
- Tests in `selfhost/tests/` (same offline `gh` stub as #132): line parsing (backticks, bare, URLs, other repos, duplicates), the picked check, the done-upstream skips, idempotency (existing marker by the same user, marker by someone else doesn't count), body link added once, missing-token error, non-merged PR, write-only-in-workflow gate; the mirror's single-issue path and close tracking without backfill; the import body's first line and the `.github/` guard (refused before any push; allowed with the flag).

### Docs

- `docs/specs/upstream-issue-mirror.md`: status note at the top, "Superseded in part by upstream-handpicked.md (2026-11-18): no automatic mirroring; daily close tracking; upstream gets one notice at merge", leaving the rest as history.
- `docs/fork-workflow.md`: rewrite "Mirroring upstream issues" as "Picking upstream issues and PRs"; new "Telling upstream" section (what is posted, when, the `Upstream:` line, the token and environment setup, renewal); intro and the "never ping upstream" sentence updated; new files in "What lives where".
- `docs/fork-roadmap.md`: baseline line updated; item 28's "Why" updated.

## Owner steps (after approval and merge)

1. Create the token: <https://github.com/settings/tokens/new> (classic). Note "LearnHarness nightly upstream notice", expiry 1 year, tick only **public_repo**, **Generate token**.
2. The `upstream-notify` environment with the `main`-only rule already exists (created during the build with your `gh` login, before merge, so the workflow never auto-creates an unprotected one). You add the secret yourself (it prompts; the token never goes in chat):

   ```sh
   gh secret set UPSTREAM_COMMENT_TOKEN --env upstream-notify -R max-miller1204/learnharness-nightly
   ```

3. Optional, separate: delete the old `FORK_BOT_TOKEN` repository secret (`gh secret delete FORK_BOT_TOKEN -R max-miller1204/learnharness-nightly`) and revoke that PAT if it's still live.

The first real upstream comment happens on your next merge of a PR with an `Upstream:` line for a picked item. Nothing is posted by this PR or its tests.

## Verification

1. Unit tests above, offline, in CI (`node --test selfhost/tests/*.test.ts`).
2. `DRY_RUN=1 BODY_FILE=<a body with an Upstream: line> selfhost/scripts/notify-upstream.sh <a real merged fork PR>` with my `gh` login against real upstream: prints the exact comment, the body edit and the receipt, and says it would skip because the item isn't picked (no mirror exists today). A second dry run with a stub mirror in the unit tests covers the "would post" path. No real comment is posted upstream.
3. The import body and the `.github/` guard: through the unit tests (the import script writes for real, so it's not run live).
4. CI `Check` green, one independent review round, `prove-learnharness` (CI and scripts only; no app surface).

## Out of scope

Opening PRs upstream (item 28), syncing upstream edits or comments into mirrors, commenting at import time, notifying for items that weren't picked.
