# Spec: hardening the upstream PR import and issue mirror

Status: bug fix. Decisions made by the owner on 2026-11-17: nothing the fork does may ever ping upstream; copied text goes in a fence longer than any tilde run in it; only issues the fork bot App opened count as mirrors, and real writes happen only from the workflow (local runs are `DRY_RUN=1`).
Base: main at 3454c1b (includes PR #16, the issue mirror).

## What main does today (measured on GitHub's renderer, `POST /markdown`, mode `gfm`)

- `selfhost/scripts/import-upstream-pr.sh` puts a space before a `~~~~` line in the copied description. A line with up to 3 spaces still closes a tilde fence, so a description `hi` / `~~~~` / `@octocat #1` renders `@octocat` as a live mention and `#1` as a live issue link outside the block.
- `selfhost/scripts/mirror-upstream-issues.sh` indents a line starting with up to 3 spaces and `~~~~` to 4 spaces, but it splits lines on LF only. CommonMark also ends a line at a lone CR, so `hi\r~~~~\r@octocat #1` closes the fence and renders the same live mention and link.
- The mirror counts any fork issue whose first line is the marker `<!-- upstream-issue: amosblomqvist/learnharness#N -->` as the mirror of upstream #N, whoever opened it. Anyone who can open a fork issue can block #N from ever being mirrored, or have the label pass add or remove `upstream-closed` on their issue.
- The new-mirror loop, its per-issue label list and the `upstream-closed` pass read jq output through process substitution, so a jq error ends the loop early and the run still exits 0 with a normal summary.
- None of the 101 mirrors or the imported PR on the fork today is affected: no bot-made body has a lone CR, an escaped fence line or an unbalanced fence, and GitHub's rendered HTML of each has no mention, team, issue or commit link.

## Change

- New `selfhost/scripts/fence.jq`, shared by both scripts (`jq -L <scripts dir>`, `include "fence";`): `fence($empty)` wraps the text in a `markdown` tilde block whose fence is one tilde longer than the longest tilde run anywhere in the text, and at least 4. The text is copied unchanged. Empty or null text becomes `$empty` (`(none)` for a PR description, `(empty)` for an issue body or comment, as before).
- The import script renders the description with `fence("(none)")`; the mirror script uses `fence("(empty)")` for the body and each comment. Everything else in both bodies is unchanged.
- The mirror script counts a fork issue as a mirror only if `user.login` is `FORK_BOT_LOGIN` (default `learnharness-nightly-bot[bot]`, the login every existing mirror has) and its first line is the marker. This applies to both the new-mirror pass and the `upstream-closed` pass.
- The mirror script writes only when `GITHUB_ACTIONS=true` (the workflow, as the bot). Otherwise it exits 1 with "run locally with DRY_RUN=1" before any call, unless `DRY_RUN=1`.
- The mirror script's loops and label list read from files written by a prior jq command, so a jq error fails the run (`set -e`) before any summary line.
- `selfhost/tests/upstream-scripts.test.ts` runs both scripts offline with stub `gh`, `git` and `sleep` and a `jq` wrapper that can inject a failure; it runs in CI's Launcher tests job.
- Docs: `docs/specs/upstream-issue-mirror.md` and `docs/fork-workflow.md` describe the fence, the bot-only matching and the workflow-only writes.

## Done looks like

1. A PR description or issue body or comment that tries every fence close (column 0, 1 to 3 spaces, a tab, a longer run, CRLF, a lone CR) followed by `@octocat`, `#1`, `@org/team`, `owner/repo#2` and `</details>` sits verbatim inside one block in the rendered fork body, and GitHub's renderer shows none of them as a link or mention (no `user-mention`, `team-mention`, `issue-link` or `commit-link` in the HTML).
2. A fork issue opened by anyone other than the bot with a marker for upstream #N does not stop #N from being mirrored, and is never edited by the label pass. The bot's own mirrors are recognized exactly as before: a real `DRY_RUN=1` against upstream prints the same plan as main.
3. Without `DRY_RUN=1` and outside the workflow, the mirror script exits 1 and makes no `gh` call. With `DRY_RUN=1` it makes only read calls.
4. An injected jq failure in the new-mirror list, a mirror's label list or the `upstream-closed` pass makes the run exit non-zero without printing the summary.
5. CI `Check` is green, with the new tests in Launcher tests.

## Must keep working (existing flows, answer key is the base commit)

- The mirror's body layout, marker line, credit line, title, labels, size fitting, per-run cap, pauses and summary line. For text with no tilde run of 4 or more, the body is byte-identical to main's.
- The import's branch push, PR create or update, title and the rest of its body.
- The workflows themselves (`import-upstream-pr.yml`, `mirror-upstream-issues.yml`) are unchanged apart from the mirror workflow's "Local dry run" comment; the mirror workflow already runs with `GITHUB_ACTIONS=true` as the bot.

## Not changed

- Existing mirrors and imported PRs are not rewritten (copied once; none is affected, see above).
- Titles are copied as before (`[upstream issue N] <title>`, `[upstream PR N] <title>`).
- The import script still runs locally with your `gh` login (it opens PRs, which have no matching step).
