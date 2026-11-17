# Fork workflow

`max-miller1204/learnharness-nightly` is a curated, fast-moving version of [`amosblomqvist/learnharness`](https://github.com/amosblomqvist/learnharness). Upstream PRs are reviewed and merged here, often before upstream lands them, and new work goes straight to `main`. Upstream is a source of ideas to pick from, not something that lands on its own. Every push to `main` that passes CI becomes a nightly (see [self-hosting](self-hosting.md)).

## The Sync PR

`.github/workflows/upstream-sync.yml` runs every hour:

1. It mirrors upstream `main` to the `upstream-main` branch (only the bot writes there).
2. If `main` already contains it, any open Sync PR is closed.
3. Otherwise it keeps **one** PR, "Sync upstream (N new commits)", open from `upstream-main` into `main`. The body lists the new upstream commits, the upstream PRs they mention, and whether GitHub sees conflicts. CI runs on it.

It never pushes to `main`. Read it, take what's worth taking, and merge with **Create a merge commit** (never squash or rebase) so the next sync knows those commits are in. To take only part of it, branch from `main`, merge or cherry-pick what you want, and leave the Sync PR open; it updates itself.

Upstream often lands a reworked version of a PR you already merged here, so conflicts are expected. Resolve them in the PR, or locally: `git fetch origin upstream-main`, then merge it into a branch from `main`.

## CI and the `Check` gate

`.github/workflows/ci.yml` runs on every PR and every push to `main` (design: [specs/ci-foundation.md](specs/ci-foundation.md)). A first `Changes` job reads the PR's diff and skips jobs it can't affect: a docs-only PR runs only lint, and a tests-only PR skips the three standalone builds. Pushes to `main` always run everything. The last job, **`Check`**, passes only when every other job passed or was skipped for that reason.

`main` requires `Check`: a PR merges only when its `Check` is green, and **direct pushes to `main` must now pass `Check` too.** Push to a branch and open a PR instead. A new push to a PR cancels its older CI run.
Repository admins can bypass the required `Check` (GitHub's default; the rule doesn't enforce it for admins).

The nightly starts only after CI passes on a push to `main`, and builds that exact commit.

`.github/workflows/pr-agent.yml` runs [PR-Agent](https://github.com/The-PR-Agent/pr-agent) on every PR: an AI review and code suggestions as comments, on open and on each push. It's advisory and never blocks a merge. People with write access can also comment `/review`, `/improve`, `/describe` or `/ask ...` on a PR. It uses the `OPENROUTER_API_KEY` secret and the model in the `OPENROUTER_MODEL` repository variable (a bare OpenRouter ID such as `anthropic/claude-haiku-5.5`, which is also the default when the variable is unset). It runs with low reasoning effort.

## Importing an upstream PR

Run **Actions → Import upstream PR** with the PR number, or locally:

```sh
selfhost/scripts/import-upstream-pr.sh 674
```

It pushes the PR's exact commits to `upstream-pr/<N>` (same commit IDs as upstream) and opens or updates a fork PR "[upstream PR N] <title>" that names the original and credits its author. Run it again to pick up new pushes to the upstream PR.

**Merge imported PRs with "Create a merge commit", never squash.** When upstream later merges the same commits, git sees them as already merged and the Sync PR stays clean. (Upstream's maintainer often reworks PRs before landing them; those reworked versions still conflict, and you resolve them once in the Sync PR.)

The bots never ping anyone upstream: upstream PR references are written as code, and an imported PR's original description is copied into a collapsed code block. So no `@mentions` fire, and nothing adds "mentioned this" entries to upstream's timelines.

## Fork bot (GitHub App)

PRs opened with GitHub's built-in workflow token don't trigger CI, so the sync and import workflows authenticate as a private GitHub App installed only on this fork (design: [specs/github-app.md](specs/github-app.md)). Each run mints a token that lasts at most an hour, through the shared `.github/actions/fork-bot-token` step, which also makes it the `gh` and `git` credential for the rest of the job. Nothing expires and nothing is tied to your account. Bot PRs show the App as author and run CI, including `Check`. PR-Agent skips them (it ignores bots); comment `/review` on one when you want a review.

The token can push branches (Contents), open, edit, close and comment on PRs (Pull requests), and push commits that edit `.github/workflows/*` (Workflows), on this repository only.

To create it (once, as the repository owner):

1. Open <https://github.com/settings/apps/new>.
2. **GitHub App name:** any globally unique name; PRs show it as `<name>[bot]`. **Homepage URL:** `https://github.com/max-miller1204/learnharness-nightly`.
3. **Webhook:** untick **Active**.
4. **Repository permissions:** Contents: Read and write; Pull requests: Read and write; Workflows: Read and write. Metadata: Read is set automatically. Nothing under Organization or Account permissions.
5. **Where can this GitHub App be installed?** Only on this account. **Create GitHub App**.
6. Copy the **Client ID** from the App's page. Under **Private keys**, **Generate a private key**; a `.pem` downloads.
7. **Install App** (left menu) → your account → **Only select repositories** → `learnharness-nightly` → **Install**.
8. Store both as repository secrets, then delete the `.pem` (or keep it in a password manager):

   ```sh
   gh secret set FORK_BOT_CLIENT_ID -R max-miller1204/learnharness-nightly   # paste the Client ID
   gh secret set FORK_BOT_PRIVATE_KEY -R max-miller1204/learnharness-nightly < path/to/key.pem
   ```

The workflows fail with a clear message when either secret is missing. To replace a lost or leaked key, generate a new one on the App's page, store it the same way and delete the old key there. A future workflow that needs more access (for example Issues) gets it by adding the permission on the App's page and approving the change on the installation.

## One-time repository settings

- **Enable Actions on the fork.** GitHub turns off workflows inherited by a fork until you click "I understand my workflows, go ahead and enable them" on the Actions tab. Nothing builds or syncs until then.
- **Disable inherited workflows** that don't apply to the fork: `gh workflow disable "Desktop release"` and `gh workflow disable notify-website`. (Tags created by the nightly use the built-in token, which can't start other workflows anyway; disabling makes it explicit.)
- **Allow merge commits** (Settings → General → Pull Requests), since upstream-derived PRs must use them.
- **Branch protection on `main`:** require the `Check` status check, nothing else.
- **`OPENROUTER_API_KEY`** secret for PR-Agent. Optional: an `OPENROUTER_MODEL` variable to change its model.
- Optional: `PAUSE_NIGHTLY=true` as a repository variable stops publishing nightlies.

## What lives where

| Path | Purpose |
|---|---|
| `selfhost/` | The `lh` launcher, installer, packaging scripts and their tests (`node --test selfhost/tests/*.test.ts`) |
| `src/server/self-update.ts`, `app/api/updates`, `app/api/health` | The in-app updater and the launcher's health check |
| `src/server/data-lock.ts` | One server per data folder |
| `.github/workflows/ci.yml`, `.github/scripts/ci-changes.cjs`, `.github/actions/setup-deps/` | CI, its affected-only gating, and the cached install |
| `.github/workflows/pr-agent.yml` | Advisory AI review on PRs |
| `.github/workflows/nightly.yml`, `feed-check.yml` | Build, publish and verify nightlies |
| `.github/workflows/upstream-sync.yml`, `import-upstream-pr.yml` | Upstream feed and PR intake |
| `.github/actions/fork-bot-token/` | Mints the fork bot App token for workflows that push or open PRs |
| [`fork-roadmap.md`](fork-roadmap.md) | Work considered and deliberately deferred |
