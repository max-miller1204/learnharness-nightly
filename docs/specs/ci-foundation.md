# CI foundation

Status: approved by the owner on 2026-11-17.

Goal: PR checks in about T3 Code's time (T3 PRs take about 3 minutes end to end) while running at least what CI runs today, plus advisory AI review from PR-Agent. GitHub standard runners only.

## Where we start (measured on PR run 44088931853)

| Job | Wall time | Where it goes |
|---|---|---|
| Typecheck, tests, lint (serial) | 556 s | `npm ci` 39 s, `plugins:setup` 44 s, typecheck 26 s, **tests 419 s**, lint 14 s |
| Standalone linux-x64 | 141 s | install 47 s, build 51 s |
| Standalone mac-arm64 | 195 s | install 72 s, build 75 s |
| Standalone windows-x64 | 296 s | install 137 s, build 78 s |

The test step (420 files, 5,336 tests, 3 workers on a 4 vCPU runner) is the critical path. Install costs 47 to 137 s in every job, and `plugins:setup` runs `npm ci` in five plugin folders (about 850 MB of extra `node_modules`).

## Decided by the owner

1. PR-Agent runs on every PR in its own workflow, in parallel with CI, advisory only. OpenRouter, secret `OPENROUTER_API_KEY`, model ID in a repository variable, default DeepSeek V4.1 Flash.
2. Split the serial job into parallel jobs; shard tests about 4 ways with `--test-shard`.
3. T3-style affected-only gating on PRs; fails open; pushes to `main` run everything.
4. Cache npm, the Next.js build cache, the Electron download and Chromium. Standard runners only.
5. One required-check aggregator named `Check`; concurrency cancels stale PR runs.
6. `nightly.yml` reuses CI's result for the same SHA instead of repeating the quality job.

## Design

### Workflow layout (`.github/workflows/ci.yml`)

Triggers unchanged: `push` to `main`, `pull_request`, `workflow_dispatch`.

Concurrency (T3, adopted): `group: ci-${{ github.event.pull_request.number || github.sha }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. A new push to a PR cancels the older run; runs on `main` are never cancelled.

Jobs, all on `ubuntu-24.04` unless noted:

| Job id | Name | Needs | Runs when | Does |
|---|---|---|---|---|
| `changes` | Changes | none | always | Maps the diff to the gates below (see "Affected-only gating"). |
| `lint` | Lint | none | always (T3: lint always runs) | install, `npm run lint`, `node --test .github/scripts/*.test.cjs` |
| `typecheck` | Typecheck | `changes` | `typecheck != false` | install, `npm run typecheck` |
| `test` | Test (1..4) | `changes` | `test != false` | matrix `shard: [1, 2, 3, 4]`, `fail-fast: false`; install, Electron cache, `NODE_ENV=test npx tsx --test --test-shard=${shard}/4 tests/*.test.ts tests/*.test.tsx` |
| `selfhost` | Launcher tests | `changes` | `selfhost != false` | checkout + setup-node only (the launcher uses Node built-ins), `node --test selfhost/tests/*.test.ts` |
| `standalone` | Standalone (platform) | `changes` | `standalone != false` | Same matrix and steps as today (macos-15, windows-2025, ubuntu-24.04), plus the caches below |
| `check` | Check | all of the above | `always()` | T3's aggregator (below) |

`npm test` in `package.json` stays as it is for local use; the shard command in CI is the same command plus `--test-shard`. (Verified locally: `tsx --test --test-shard=1/200 ...` runs only its slice.)

Expected PR critical path: about 20 s `changes`, then a test shard of about 30 s setup plus about 105 s of tests, so about 3 minutes; the Windows standalone job (about 3 to 4 minutes with caches) may be the longest. The PR records the measured times. If one shard runs much longer than the others, the shard count changes in this PR, not the approach.

### `Check` aggregator (T3 ci.yml pattern, adopted)

`name: Check`, `if: always()`, `needs:` every other job. It prints each job's result and fails unless every job is `success`, or `skipped` while `changes` set that job's gate to `false`. `always()` (not `!cancelled()`) so a cancelled run still produces a failing `Check`. Adding or resharding jobs never needs a branch-protection change, because only `Check` is required.

### Affected-only gating

Ported from T3's `.github/actions/ci-changes/action.yml` and `.github/scripts/ci-changes.cjs` (MIT, notice kept in the file header), cut down because LearnHarness is one package, not a workspace graph.

How the diff is read (T3, adopted): `changes` checks out with `fetch-depth: 2`. On `pull_request` the merge commit's first parent is the base, so it diffs `HEAD^1..HEAD`. On `push` and `workflow_dispatch` it passes `--full` and every gate is true (main is the backstop). `git diff --name-only --no-renames`, so a rename counts as both paths. If the base cannot be fetched or the diff fails, it fails open: everything runs.

Outputs: `typecheck`, `test`, `selfhost`, `standalone` (`true`/`false`). Each changed file is classified; the gates are the union:

| Class | Paths | Gates it turns on |
|---|---|---|
| Inert | `docs/**` except the files the app or its plugin-authoring bundle ships (the nine `AUTHORING_DOCS` in `scripts/build-plugin-authoring.mjs`, `docs/plugin-api/**`, `docs/compaction-accounting.md` which electron-builder packages); root `*.md`; `LICENSE`; `.claude/**`; `.github/ISSUE_TEMPLATE/**`; `.github/workflows/pr-agent.yml` | none (lint and `Check` still run) |
| Tests only | `tests/**` except `tests/helpers/**`, `tests/fixtures/**` and the four native renderer tests the standalone job runs | `typecheck`, `test` |
| Everything else | any other path, including all of `.github/`, `selfhost/` (the server imports it), `plugins/`, `skills/`, `examples/`, `package*.json` | all four |

So a docs-only PR runs only `changes`, `lint` and `Check`; a tests-only PR skips the three standalone builds.

The classifier gets a small `node:test` suite (`.github/scripts/ci-changes.test.cjs`) that the `lint` job runs: docs-only, shipped docs, tests-only, native test, unknown path, `--full`, no `--paths` (fail open).

### Caching

**Dependencies.** A local composite action, `.github/actions/setup-deps`, used by every job that installs:
- `actions/setup-node@v7` with Node 26 and no npm store cache (restoring the multi-GB `~/.npm` would cost every job time the `node_modules` cache already saves).
- Restore a cache of `node_modules` plus `plugins/*/node_modules`, keyed exactly on `runner.os`, `runner.arch`, the Node version and the hash of `package-lock.json` and `plugins/*/package-lock.json`. No restore-keys: a hit is byte-for-byte what `npm ci` would produce from that lockfile, a miss runs the full install.
- On a miss: `npm ci` and `npm run plugins:setup`, then save the cache immediately (before anything runs, so no build or test output gets into it). PRs save only when based on `main` (T3's rule for its store cache).
- On a hit: only regenerate each plugin's `.sdk` types (the `sdk` script `plugins:setup` already runs), because they come from repo source, not from the lockfile. This needs a `--sdk-only` flag on `scripts/setup-plugins.mjs`.

**Electron download.** `electron_config_cache` set to a fixed folder, cached with key `electron-${os}-${arch}-${electron version from package-lock.json}` (T3 caches `~/.cache/electron` the same way). Used by the test shards (some tests start Electron) and the standalone jobs.

**Next.js build cache.** `.next/cache` in the standalone jobs, per the Next docs (`ci-build-caching.md`): key `nextjs-${os}-${arch}-${lockfile hash}-${source hash}` with restore-key `nextjs-${os}-${arch}-${lockfile hash}-`. Restored on every run, saved only on pushes to `main` so PRs don't evict each other (T3's rule for its Vitest cache).

**Chromium.** Nothing to cache: LearnHarness never downloads Chromium. Headless work uses Electron's own `--browser-service` or a system Chrome (`src/agent/subagents/headless.ts`, `scripts/smoke-plugin-browser.mjs` says "never downloads Chromium"), and GitHub's runner images ship Google Chrome. The Electron cache above covers the browser service.

**Not cached on purpose.** `nightly.yml` and `release.yml` keep cold installs and cold Next builds, so the builds users run never come from a cache.

`tests/desktop-platform.test.ts` pins the exact set of Actions `ci.yml` may use and requires `cache: npm` on every `setup-node`. It is updated to allow `actions/cache/restore@v6` and `actions/cache/save@v6` and the local `./.github/actions/setup-deps`, and to check the setup-node rules inside the composite action instead. Its checks on the `standalone` job (native renderer step, `smoke-server.mjs --electron`, `macos-15`) keep passing unchanged.

### PR-Agent (`.github/workflows/pr-agent.yml`)

- Action pinned by image digest: `docker://pragent/pr-agent:0.50.0-github_action@sha256:548e894a88071180832b2f4233f734d0acd0db1a879e2fcbaa70bac8b8372ebe` (latest release, 2026-11-07). The upstream docs' `@main` is not used.
- Triggers: `pull_request` (`opened`, `reopened`, `ready_for_review`, `synchronize`) and `issue_comment` for `/review`, `/improve`, `/ask`. A comment runs it only when the commenter is `OWNER`, `MEMBER` or `COLLABORATOR`, so strangers on this public repo can't spend the key. Skips bot senders and PRs from forks (no secrets there).
- Permissions: `contents: read`, `issues: write`, `pull-requests: write`.
- Concurrency: `pr-agent-${PR number}`, cancel in progress.
- Model: `config.model: openrouter/${{ vars.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash-1017' }}`, `config.fallback_models: '[]'`, `OPENROUTER.KEY: ${{ secrets.OPENROUTER_API_KEY }}`, `config.custom_model_max_tokens: 1048576` (PR-Agent doesn't know this model's context), `config.max_model_tokens: 128000` (default 32000 clips big diffs; 128k input costs under a cent on this model).
- Tools: `/review` and `/improve` run automatically on open, reopen, ready for review and each push (`github_action_config.auto_review: true`, `auto_improve: true`, `auto_describe: false`, `pr_actions` plus `handle_push_trigger: true` with `push_commands: ['/review', '/improve']`). No automatic `/describe`, because it rewrites the PR title and body; owners and collaborators can still comment `/describe`. PR-Agent already reads `AGENTS.md` as repo context by default.
- It is not in `Check` and never required. A failure shows on the PR but blocks nothing.

**Variable name: `OPENROUTER_MODEL`.** It holds the bare OpenRouter model ID (default `deepseek/deepseek-v4.1-flash-1017`, the 2026-10-17 snapshot), so the later AI release notes can send it to OpenRouter as is; PR-Agent adds its `openrouter/` prefix in the workflow. It pairs with the `OPENROUTER_API_KEY` secret. The workflow falls back to the default when the variable is unset, so nothing has to be created for it to work.

### Nightly reuses CI (`.github/workflows/nightly.yml`)

Mechanism (owner choice): `nightly.yml` triggers on `workflow_run` of `CI`, `types: [completed]`, `branches: [main]`, and runs only when that run's `conclusion` is `success` and its event was `push`. Every job builds `github.event.workflow_run.head_sha` (not `github.sha`, which for `workflow_run` is the latest `main`), including the version metadata, the "already shipped" check, release notes, the feed entry and the release target. A manual `workflow_dispatch` builds the current `main` head and first looks up the `Check` check run for that SHA; it refuses unless `Check` concluded `success`.

Also:
- The `quality` job is removed from `nightly.yml`.
- The launcher tests it ran move into CI (`selfhost` job), so they now also run on PRs (T3 runs its release checks on PRs too).
- Nightly publishes only when CI's `Check` passed for the exact commit it builds. Its `Bundle` jobs (build, archive, archive smoke, launcher tests on each arch) stay; they are packaging, not a repeat of CI.
- `PAUSE_NIGHTLY`, the dry-run input, the "already shipped" skip, the `nightly` concurrency group and `feed-check.yml` keep working.

`release.yml` is unchanged: tag releases are rare and keep their own full gate.

### Other open points from the brief

- **`selfhost/tests` on PRs:** yes, as the `selfhost` job above (T3 parity).
- **More smoke scripts on PRs:** not in this PR. CI already runs `smoke-provider-runtime` and `smoke-server --electron` (which runs `smoke-plugin-runtime`, `smoke-core-plugins`, `smoke-compression-runtime` and `smoke-plugin-browser` inside it). The others (`smoke-demo-runtime --browser` needs a packaged app; `smoke-file-paths`, `smoke-opening-prompt`, `smoke-learner-images`, `smoke-web-subscriptions`, `smoke-image-runtime` need a running dev server or browser setup) are a separate item.
- **Plugin test suites** (`plugins/*/` `npm test`, `typecheck`) don't run in CI today and still won't. Noted for a later item.
- **Required check:** after this PR merges and `Check` has run on `main`, a branch protection rule on `main` requires the `Check` status. Nothing else changes (no review requirement, "up to date" off, the admin setting left at GitHub's default). `docs/fork-workflow.md` says in this PR that direct pushes to `main` must now pass `Check`.

## Not in scope

Paid or larger runners, release.yml changes, new smoke coverage, plugin test suites, AI release notes (item 7).

## How this is proved

- CI on the PR: every job green, `Check` green, measured times recorded in the PR body next to the 556 s baseline.
- Gating: in the PR, a docs-only commit (pushed and then reverted, or a throwaway branch) shows the standalone, test and typecheck jobs skipped and `Check` green; a deliberately failing test in one shard shows `Check` red.
- Caches: a second run shows cache hits for `node_modules`, Electron and `.next/cache` (the last only after a push to `main`).
- PR-Agent: posts a review comment on this PR using the configured model.
- Nightly: after merge, the next nightly starts only after CI's `Check` passed for that SHA, and publishes.
- The classifier's unit tests pass.

## Owner decisions on the open questions

- **Q1 Nightly reuse:** `workflow_run` on CI (above).
- **Q2 Dependency cache:** `node_modules` cache with an exact lockfile key (above), not the npm store.
- **Q3 Model:** `deepseek/deepseek-v4.1-flash-1017`.
- **Q4 PR-Agent tools:** auto review and improve, no auto describe.
- **Q5 Required `Check`:** yes, after merge, `Check` only; `docs/fork-workflow.md` updated in this PR.
