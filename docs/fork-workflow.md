# Fork workflow

`max-miller1204/learnharness-nightly` is a curated, fast-moving version of [`amosblomqvist/learnharness`](https://github.com/amosblomqvist/learnharness). Upstream PRs are reviewed and merged here, often before upstream lands them, and new work goes straight to `main`. Upstream is a source of ideas to pick from, not something that lands on its own. Every push to `main` that passes CI becomes a nightly (see [self-hosting](self-hosting.md)).

## The Sync PR

`.github/workflows/upstream-sync.yml` runs every hour:

1. It mirrors upstream `main` to the `upstream-main` branch (only the bot writes there).
2. If `main` already contains it, any open Sync PR is closed.
3. Otherwise it keeps **one** PR, "Sync upstream (N new commits)", open from `upstream-main` into `main`. The body lists the new upstream commits, the upstream PRs they mention, and whether GitHub sees conflicts. CI runs on it.

**It pauses when upstream changes `.github/`.** Pushing `upstream-main` runs that branch's own workflow files here, so when upstream's `.github/` differs from what `upstream-main` holds now, the run pushes nothing, leaves the Sync PR as it is and fails (GitHub emails you), naming the files and linking the diff. Read it, then run **Actions → Upstream sync** with **allow_github_changes** ticked. Until then every hourly run stays paused and red.

It never pushes to `main`. Read it, take what's worth taking, and merge with **Create a merge commit** (never squash or rebase) so the next sync knows those commits are in. To take only part of it, branch from `main`, merge or cherry-pick what you want, and leave the Sync PR open; it updates itself.

Upstream often lands a reworked version of a PR you already merged here, so conflicts are expected. Resolve them in the PR, or locally: `git fetch origin upstream-main`, then merge it into a branch from `main`.

## CI and the `Check` gate

`.github/workflows/ci.yml` runs on every PR and every push to `main` (design: [specs/ci-foundation.md](specs/ci-foundation.md)). A first `Changes` job reads the PR's diff and skips jobs it can't affect: a docs-only PR runs only lint, and a tests-only PR skips the three standalone builds. Pushes to `main` always run everything. The last job, **`Check`**, passes only when every other job passed or was skipped for that reason.

`main` requires `Check`: a PR merges only when its `Check` is green, and **direct pushes to `main` must now pass `Check` too.** Push to a branch and open a PR instead. A new push to a PR cancels its older CI run.

Repository admins can bypass the required `Check` (GitHub's default; the rule doesn't enforce it for admins).

When GitHub cancels a job because no hosted runner picked it up (the macOS arm64 queue under capacity constraints), `.github/workflows/ci-runner-retry.yml` re-runs the run's failed jobs and `Check` on its own, at most 3 times per run (whether it chains past the first re-run is unproven until a real case; see the spec). Real failures and cancels by a newer push or a person are left alone (design: [specs/ci-runner-retry.md](specs/ci-runner-retry.md)).

The nightly starts only after CI passes on a push to `main`, and builds that exact commit.

`.github/workflows/pr-agent.yml` runs [PR-Agent](https://github.com/The-PR-Agent/pr-agent) on every PR: an AI review and code suggestions as comments, on open and on each push. It's advisory and never blocks a merge. People with write access can also comment `/review`, `/improve`, `/describe` or `/ask ...` on a PR. It uses the `OPENROUTER_API_KEY` secret and the model in the `OPENROUTER_MODEL` repository variable (a bare OpenRouter ID such as `anthropic/claude-haiku-5.5`, which is also the default when the variable is unset). It runs with low reasoning effort.

## Importing an upstream PR

Run **Actions → Import upstream PR** with the PR number, or locally:

```sh
selfhost/scripts/import-upstream-pr.sh 674
```

Import only the upstream PRs you've picked as good contributions; nothing is imported on its own. It pushes the PR's exact commits to `upstream-pr/<N>` (same commit IDs as upstream) and opens or updates a fork PR "[upstream PR N] <title>" that links the original by URL and credits its author. The link adds a "mentioned this" entry to the upstream PR's timeline, so upstream users can find the fork's version. Run it again to pick up new pushes to the upstream PR.

**An upstream PR that changes anything under `.github/` is refused.** Its branch's own workflows would run here, with this repository's token and repository secrets, as soon as it's pushed. The same goes for an upstream PR whose branch has a `.github/` that differs from `upstream-main` in any other way, for example upstream changes on its `main` that the paused sync is holding back. Read its diff (the error links it), and if it's safe, run the import again with **allow_github_changes** ticked (`ALLOW_GITHUB_CHANGES=1` locally). The check runs on the exact commit it pushes.

**Merge imported PRs with "Create a merge commit", never squash.** When upstream later merges the same commits, git sees them as already merged and the Sync PR stays clean. (Upstream's maintainer often reworks PRs before landing them; those reworked versions still conflict, and you resolve them once in the Sync PR.)

Apart from that link, importing pings no one upstream: the author is written as code, and an imported PR's original description is copied into a collapsed code block. The block's fence is one tilde longer than any run of tildes in the copied text, and at least 4 (`selfhost/scripts/fence.jq`, shared with the issue mirror). GitHub caps a fence at 255 tildes, so text with a run of 255 or more instead gets a 255-tilde fence, LF line endings and its tilde-led lines indented to 4 spaces. Either way nothing in it can close the block early. So no `@mentions` fire, and nothing in it adds "mentioned this" entries to upstream's timelines.

## Picking upstream issues

Upstream issues aren't mirrored on their own any more: you pick the ones worth working on (design: [specs/upstream-handpicked.md](specs/upstream-handpicked.md), first version [specs/upstream-issue-mirror.md](specs/upstream-issue-mirror.md)). Run **Actions → Mirror upstream issues** with the upstream issue number, and it copies that issue into the fork **once**:

- A mirror is a fork issue "[upstream issue N] <title>" labeled `upstream`, plus upstream's own labels that exist here. Its body links the upstream issue by URL (a "mentioned this" entry upstream), credits the author and quotes the original issue and the comments it had at copy time. Later upstream edits and comments aren't copied.
- A daily run (06:47 UTC) creates nothing. It keeps `upstream-closed` on each mirror while its upstream issue is closed, and removes it if upstream reopens it. The job never opens or closes fork issues.
- The hidden first line of a mirror's body (`<!-- upstream-issue: amosblomqvist/learnharness#N -->`) is how the jobs find it, and only issues the fork bot opened (`learnharness-nightly-bot[bot]`) count. Keep that line, or the issue no longer counts as mirrored. An issue anyone else opens with that line is ignored, so it can't block or relabel a mirror.
- Apart from that link, mirroring pings no one upstream: authors are written as code and the copied text sits in code blocks that nothing in it can close.

Only the workflow writes mirrors, because mirrors opened under any other login aren't recognized. Locally, `DRY_RUN=1 selfhost/scripts/mirror-upstream-issues.sh [N]` prints what it would do (and, with a number, the body) without writing; without `DRY_RUN=1` it refuses to run.

## Fork bot (GitHub App)

PRs opened with GitHub's built-in workflow token don't trigger CI, so the sync, import and issue mirror workflows authenticate as a private GitHub App installed only on this fork (design: [specs/github-app.md](specs/github-app.md)). Each run mints a token that lasts at most an hour, through the shared `.github/actions/fork-bot-token` step, which also makes it the `gh` and `git` credential for the rest of the job. Nothing expires and nothing is tied to your account. Bot PRs show the App as author and run CI, including `Check`. PR-Agent skips them (it ignores bots); comment `/review` on one when you want a review.

The token can push branches (Contents), open, edit, close and comment on PRs (Pull requests), create and label issues (Issues), and push commits that edit `.github/workflows/*` (Workflows), on this repository only.

To create it (once, as the repository owner):

1. Open <https://github.com/settings/apps/new>.
2. **GitHub App name:** any globally unique name; PRs show it as `<name>[bot]`. **Homepage URL:** `https://github.com/max-miller1204/learnharness-nightly`.
3. **Webhook:** untick **Active**.
4. **Repository permissions:** Contents: Read and write; Pull requests: Read and write; Issues: Read and write; Workflows: Read and write. Metadata: Read is set automatically. Nothing under Organization or Account permissions.
5. **Where can this GitHub App be installed?** Only on this account. **Create GitHub App**.
6. Copy the **Client ID** from the App's page. Under **Private keys**, **Generate a private key**; a `.pem` downloads.
7. **Install App** (left menu) → your account → **Only select repositories** → `learnharness-nightly` → **Install**.
8. Store both as secrets of the `fork-bot` environment, then delete the `.pem` (or keep it in a password manager):

   ```sh
   gh secret set FORK_BOT_CLIENT_ID --env fork-bot -R max-miller1204/learnharness-nightly   # paste the Client ID
   gh secret set FORK_BOT_PRIVATE_KEY --env fork-bot -R max-miller1204/learnharness-nightly < path/to/key.pem
   ```

**The key is main-only.** `fork-bot` is an environment whose deployment branch rule allows `main` only (Settings → Environments; design: [specs/simplify-upstream-intake.md](specs/simplify-upstream-intake.md)). The four jobs that mint the token (upstream sync, import, issue mirror, Dependabot auto-merge) use it with `deployment: false`, so they leave no deployment records. Any other branch's workflows can't read the key, including upstream branches the bot pushes. So these workflows can't be test-run from a branch: dispatched from one, the job is refused the environment. Never store the App values as repository secrets again; every branch can read those.

The workflows fail with a clear message when either secret is missing. To replace a lost or leaked key, generate a new one on the App's page, store it the same way and delete the old key there. A future workflow that needs more access gets it by adding the permission on the App's page and approving the change on the installation.

## Dependency updates

Dependabot keeps npm (the root and every `plugins/*` package) and GitHub Actions current (design: [specs/dependency-updates.md](specs/dependency-updates.md); config: `.github/dependabot.yml`). Every Monday it opens:

- **One minor/patch PR per ecosystem** with everything that has a minor or patch update (`npm-minor-patch`, `actions-minor-patch`).
- **One PR per major**, across all directories (`npm-major`, `actions-major`). The first weeks' backlog trickles in five open PRs at a time.
- **A `pi` PR** (npm only) for `@earendil-works/*` (Pi) and `typebox`, kept out of the minor/patch batch.

Security fixes don't wait for Monday. They arrive as one grouped PR per ecosystem as soon as an advisory needs one.

| PR | How it merges |
|---|---|
| Minor/patch batch, or a security PR whose biggest change is minor or patch | Auto-merges (squash) when `Check` is green. `.github/workflows/dependabot-auto-merge.yml` (on `pull_request_target`, so it always runs `main`'s copy) queues it with the fork bot App token, so the merge runs CI and the nightly on `main`. |
| A major, or a security PR that needs a major | Waits for an agent: one review round and a `prove-learnharness` run, then `gh pr merge <N> --auto --squash`. |
| `pi`, or any PR touching Pi or typebox | Arrives red by design. The four SDK plugins' lockfiles pin Pi and typebox through their generated `.sdk/package.json`. An agent runs `npm install` at the root, then `npm run sdk && npm install` in each SDK plugin, adapts code to Pi's changes, pushes to the Dependabot branch, and then treats it like a major. |

Dependabot reads the SDK plugins through their committed `.sdk/package.json` (only that file is committed; the rest of `.sdk/` stays generated). `Lint` fails when one is missing or differs from what `npm run sdk` writes. This is interim until the plugin API is a versioned package.

Dependabot rebases its own PRs when `main` moves, including after a Sync PR merge, unless someone else has pushed to the branch. In that case comment `@dependabot recreate`. If the Sync PR conflicts in `package-lock.json` after a Dependabot merge, keep upstream's `package.json` intent and regenerate the lockfile with `npm install` instead of merging it by hand. An upstream Pi or typebox bump also needs the four `.sdk/package.json` files and the plugin lockfiles regenerated in the Sync PR.

**Security overrides.** When an alert's patched version is outside what the parent package allows, an `overrides` entry in the root `package.json` forces it (the older `"katex": "$katex"` entry is not one of these). Each stays only until its removal condition holds:

- `"minimatch@>=7.0.0 <11.0.1": "^11.0.1"`: alert GHSA-g3hv-75wg-m249 (globParts DoS, fixed only in 11.0.1). electron-builder's `app-builder-lib` allows minimatch `^10.2.5` and its `@electron/universal` `^9.0.3`. The version selector applies where a dependent's declared minimatch range intersects the vulnerable range, so today only those two move to 11. The 3.x and 5.x copies (eslint, `@eslint/config-array`, `@eslint/eslintrc`, eslint-plugin-import, glob 7, `@electron/asar`, dir-compare, filelist) aren't vulnerable and stay as they are. A future dependency declaring a wide range such as `*` would also be forced to 11. Dev and build only: nothing ships in the app, server or asar. Remove it once electron-builder's tree allows minimatch 11 (without it, `npm ls minimatch` shows no copy in `>=7.0.0 <11.0.1`).

Dependabot can't update the `docker://` PR-Agent image in `pr-agent.yml`; bump it by hand when wanted. PR-Agent skips Dependabot PRs.

Once, right after the PR that added this merged, the agent turned on Dependabot alerts and security updates (Settings → Code security) and read both back:

```sh
gh api -X PUT repos/max-miller1204/learnharness-nightly/vulnerability-alerts
gh api -X PUT repos/max-miller1204/learnharness-nightly/automated-security-fixes
gh api -i repos/max-miller1204/learnharness-nightly/vulnerability-alerts    # 204 = enabled
gh api repos/max-miller1204/learnharness-nightly/automated-security-fixes   # {"enabled":true,...}
```

## One-time repository settings

- **Turn on Issues** (Settings → General → Features → Issues), so picked upstream issues have somewhere to go.
- **Enable Actions on the fork.** GitHub turns off workflows inherited by a fork until you click "I understand my workflows, go ahead and enable them" on the Actions tab. Nothing builds or syncs until then.
- **Disable inherited workflows** that don't apply to the fork: `gh workflow disable "Desktop release"` and `gh workflow disable notify-website`. (Tags created by the nightly use the built-in token, which can't start other workflows anyway; disabling makes it explicit.)
- **Allow merge commits** (Settings → General → Pull Requests), since upstream-derived PRs must use them.
- **Branch protection on `main`:** require the `Check` status check, nothing else.
- **`OPENROUTER_API_KEY`** secret for PR-Agent. It's a repository secret, which any branch's workflow can read (an accepted risk: PR-Agent runs on `pull_request`, which can't use a `main`-only environment), so keep a spending cap on the key at OpenRouter. Optional: an `OPENROUTER_MODEL` variable to change its model.
- **Allow `pull_request_target` for Dependabot auto-merge.** GitHub blocks that trigger on public repositories with no Actions event policy from 2026-12-02. One repository policy (Settings → Actions → Policies) allows it for `.github/workflows/dependabot-auto-merge.yml` only:

  ```sh
  gh api -X POST repos/max-miller1204/learnharness-nightly/actions/policies --input - <<'EOF'
  {"name": "Allow pull_request_target for Dependabot auto-merge", "enforcement": "active",
   "conditions": {"workflow_path": {"include": [".github/workflows/dependabot-auto-merge.yml"], "exclude": []}},
   "rules": [{"type": "restrict_action_events", "parameters": {"allowed_events": ["pull_request_target"]}}]}
  EOF
  ```
- Optional: `PAUSE_NIGHTLY=true` as a repository variable stops publishing nightlies.

## What lives where

| Path | Purpose |
|---|---|
| `selfhost/` | The `lh` launcher, installer, packaging scripts and their tests (`node --test selfhost/tests/*.test.ts`) |
| `src/server/self-update.ts`, `app/api/updates`, `app/api/health` | The in-app updater and the launcher's health check |
| `src/server/data-lock.ts` | One server per data folder |
| `.github/workflows/ci.yml`, `.github/scripts/ci-changes.cjs`, `.github/actions/setup-deps/` | CI, its affected-only gating, and the cached install |
| `.github/workflows/ci-runner-retry.yml`, `.github/scripts/ci-runner-retry.cjs` | Re-runs CI jobs GitHub cancelled for lack of a hosted runner |
| `.github/workflows/pr-agent.yml` | Advisory AI review on PRs |
| `.github/workflows/nightly.yml`, `feed-check.yml` | Build, publish and verify nightlies |
| `.github/workflows/upstream-sync.yml`, `import-upstream-pr.yml`, `mirror-upstream-issues.yml` | Upstream feed, picked PR imports and picked issue mirrors (scripts in `selfhost/scripts/`) |
| `.github/dependabot.yml`, `.github/workflows/dependabot-auto-merge.yml` | Dependency update PRs and their auto-merge |
| `.github/actions/fork-bot-token/` | Mints the fork bot App token for workflows that push, open PRs or mirror issues |
| [`fork-roadmap.md`](fork-roadmap.md) | Work considered and deliberately deferred |
