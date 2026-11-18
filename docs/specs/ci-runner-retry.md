# CI runner retry

Status: goal approved by the owner on 2026-11-17. The details under "Chosen by the implementer" are small technical calls (veto any).

Goal: when GitHub cancels a CI job because no hosted runner could be acquired, re-run it automatically instead of waiting for someone to click "Re-run failed jobs". `Check` still requires every job, macOS included, to pass. GitHub standard runners only.

## The failure

The `Standalone (mac-arm64)` job (`runs-on: macos-15`) sometimes queues, is never assigned a runner, and is cancelled by GitHub after about 15 minutes. `Check` then fails, so auto-merge stalls. Examples: run 44135265518 (jobs 134223289271 and, on attempt 2, 134247333020), the PR #11 run 44170120000, and the pushes to `main` 44170018632 and 44175535528.

What such a job looks like in the API:

| Field | Value |
|---|---|
| `conclusion` | `cancelled` |
| `runner_id`, `runner_name`, `steps` | `0`, `""`, `[]` |
| Check run annotations | `failure`: "The job was not acquired by Runner of type hosted even after multiple attempts", plus `notice`s "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times." |

An empty runner alone is not enough. When a newer push cancels a run (`concurrency: cancel-in-progress`), a job still waiting in the queue also has no runner and no steps, and can carry the capacity notice too (run 44162620131, job 134320261794). Those carry "Canceling since a higher priority waiting request for ci-N exists" instead of the "not acquired" annotation.

## Design

`.github/workflows/ci-runner-retry.yml` runs on `workflow_run` (`CI`, `completed`), only in `max-miller1204/learnharness-nightly` and only when the run did not succeed. It checks out `main` (sparse, `.github/scripts` only, no persisted credentials), never the PR, and runs `node .github/scripts/ci-runner-retry.cjs --run <id> --attempt <n>` with the built-in token. Job permissions: `contents: read`, `actions: write`, `checks: read` (annotations). No secrets.

The script reads the run, the jobs of its latest attempt, and the annotations of every cancelled job, then re-runs the failed jobs (`POST /actions/runs/{id}/rerun-failed-jobs`, the API behind `gh run rerun --failed`) only when all of these hold:

1. The run is completed and did not succeed.
2. Every job other than `Check` succeeded or was skipped, except at least one that was cancelled with no runner (`runner_id` 0, no `runner_name`, no steps) **and** the "was not acquired by Runner of type hosted" annotation.
3. No job failed or timed out (a real failure), no job carries the concurrency-cancel annotation, and no other job was cancelled (for example by a person).
4. The run's attempt is at most 3, so a run gets at most 3 automatic re-runs (attempt 4 is the last). Manual re-runs count toward the cap.
5. The run is still on the attempt the event reported (no one re-ran it meanwhile).
6. For a `pull_request` run, it is still the newest CI run for its branch from the same head repository (two forks can share a branch name). Re-running a superseded run would join the PR's concurrency group and cancel the newer run.

It reads everything again right before the re-run request and leaves the run if any of this changed, so a push or a manual re-run that lands while it decides is neither cancelled nor raced. The workflow also checks that the completed run is `.github/workflows/ci.yml`, since `workflows: [CI]` matches any workflow by name.

Re-running failed jobs re-runs every job that did not succeed (the cancelled job) and the jobs that need it (`Check`). Jobs that passed keep their results.

## What the built-in token means here

- **Required check and auto-merge.** The re-run's jobs report their check runs on the same head SHA from the GitHub Actions app, which is what branch protection's required `Check` names (`app_id` 15368). A green `Check` from the re-run satisfies it, and a queued `gh pr merge --auto` merges then, as with a manual re-run. The merge is made by whoever queued auto-merge, not by the built-in token, so the push to `main` still starts CI and the nightly.
- **Chained retries and the nightly (unproven).** GitHub does not start new workflow runs from events the built-in token causes (except `workflow_dispatch` and `repository_dispatch`). Public reports disagree on whether a re-run started with it fires `workflow_run` when it completes. If it does, a re-run that hits no runner again is retried again (up to the cap), and a re-run of a `main` push that passes starts the nightly. If it does not, a run gets one automatic re-run, and a `main` commit whose CI passed only on that re-run gets no nightly until the next push or a manual nightly run (which checks that `Check` passed). Either way the cap holds and nothing loops. The first real no-runner cancel after this merges shows which; record it here.

## Chosen by the implementer (veto any)

| Topic | Choice |
|---|---|
| Cap | 3 automatic re-runs per CI run (`MAX_RETRIES`). |
| Mixed runs | A run with a no-runner cancel and a real failure is not re-run: `Check` would fail anyway and the author has a fix to push. |
| Events | Pushes to `main` are re-run too (they gate the nightly); the newest-run check applies only to PR runs, since `main` runs are never cancelled by concurrency. |
| Delay | Re-run immediately; GitHub queues the job again. |
| Fork guard | `github.repository == 'max-miller1204/learnharness-nightly'`, like the Dependabot workflow, and `workflow_run.path == '.github/workflows/ci.yml'`. |

## Known gaps

- If only `Check` itself gets no runner (an Ubuntu capacity cancel), nothing is re-run: the aggregator is ignored when classifying. Rare; re-run by hand.
- A push in the milliseconds between the second read and the re-run request can still be cancelled by the re-run; push again or re-run by hand.

## Tests

`.github/scripts/ci-runner-retry.test.cjs` (run by the `Lint` job with the other `.github/scripts/*.test.cjs`) covers, with job shapes and annotation texts copied from the runs above: a no-runner cancel (re-run), including on a push to `main`; a real failure and a timeout (no re-run), also beside a no-runner cancel; a concurrency cancel of a job still waiting for a runner (no re-run); a user cancel (no re-run); the cap; a superseded, moved-on or unfinished run; a passing run.

`node .github/scripts/ci-runner-retry.cjs --run <id> --dry-run` (with `GH_TOKEN` and `GITHUB_REPOSITORY` set) prints the decision for any real run without re-running it.

## Answer key for prove-learnharness

The diff touches only `.github/` and `docs/`. It reaches no app surface (web UI, HTTP API, agent tools, server and `lh` launcher, desktop app), so there is no flow to drive. Proof is the unit tests above in CI, and dry runs against real runs, which must give:

| Run | Expected decision |
|---|---|
| 44170018632, 44175535528 (pushes to `main`, mac not acquired) | re-run, no hosted runner for `Standalone (mac-arm64)` |
| 44162620131, 44198708284, 44203272316 (newer push) | leave, cancelled by a newer run (concurrency) |
| 44183242752, 44164608044 (real failures) | leave, a real failure |
| 44135265518, 44170120000 (mac not acquired, since superseded) | leave, a newer CI run exists |
