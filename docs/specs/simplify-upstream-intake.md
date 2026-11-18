# Simplify upstream intake and protect the App key

Status: approved by the owner on 2026-11-17 (the hardening lane, rescoped by the owner to this). Supersedes the merge-time notice in `upstream-handpicked.md` (PR #236).

## Decided by the owner

1. **No merge-time upstream comment.** `notify-upstream.yml`, `selfhost/scripts/notify-upstream.sh`, `upstream-refs.jq`, their tests and docs go away, and so does the `upstream-notify` environment (empty; deleted after merge). Discovery is just a link: the PR import writes the upstream PR's full URL in the fork PR body, and the issue mirror writes the upstream issue's full URL in the mirror body, from the start. Upstream's timeline shows a "mentioned this" entry. Authors stay as code and copied text stays fenced, so nothing @mentions anyone.
2. **The App key is main-only.** `FORK_BOT_CLIENT_ID` and `FORK_BOT_PRIVATE_KEY` move into one environment, `fork-bot`, whose deployment branch rule allows `main` only. The four jobs that mint the App token use it: upstream sync (schedule, dispatch), import (dispatch), issue mirror (schedule, dispatch), Dependabot auto-merge (`pull_request_target`, which GitHub evaluates against the default branch). A workflow on any other branch, including an upstream branch the bot pushed, can't read the key. Cost: these workflows can't be test-run from a branch any more.
3. **The sync pauses on upstream `.github/` changes.** When upstream main's `.github/` differs from the fork's current `upstream-main`, the hourly run pushes nothing and doesn't touch the Sync PR. It ends red, listing the files and how to approve. After reading the diff, run **Actions → Upstream sync** with **allow_github_changes** ticked (as for the import).
4. **`OPENROUTER_API_KEY` stays a repository secret** (accepted risk). The owner puts a spending cap on the key at OpenRouter. PR-Agent is unchanged.
5. **Added after the review round:** the PR import also refuses a branch whose `.github/` differs from the fork's `upstream-main` (`git diff --name-only upstream-main <PR head> -- .github`), not only the PR's own `.github/` changes. Otherwise an import based on upstream changes the paused sync is holding back would push them. Same `allow_github_changes` flag. Real upstream PRs: 757 passes, 729 is refused.
6. Everything else from the hardening list is dropped (no `Fixes #N` scan, no low items).

## Small choices (veto any)

- `fork-bot` jobs use `environment: {name: fork-bot, deployment: false}`, so the hourly sync creates no deployment records. Checked live before merge: a job on a scratch branch is refused the environment.
- The pause compares trees (`git diff --name-only origin/upstream-main <upstream main> -- .github`), so a change that's later reverted still counts until it's gone, and an upstream force-push is covered. If `upstream-main` is missing, it compares against the merge base with `main`.
- **Dependabot auto-merge and the Dec 2 block.** GitHub blocks `pull_request_target` on public repositories with no Actions event policy from Dec 2, 2026. The fork has none, so auto-merge would stop. The fix is one repository Actions policy (Settings → Actions → Policies): `pull_request_target` allowed for `.github/workflows/dependabot-auto-merge.yml` only. I create it with your `gh` login and read it back. It can only be proven after Dec 2.
- The import's error message and the fork-bot-token step's missing-secret message name the `fork-bot` environment.

## Owner steps

1. Before merge: `fork-bot` is created with your `gh` login, with the `main`-only rule. You re-enter the two values (they can't be read back):

   ```sh
   gh secret set FORK_BOT_CLIENT_ID --env fork-bot -R max-miller1204/learnharness-nightly
   gh secret set FORK_BOT_PRIVATE_KEY --env fork-bot -R max-miller1204/learnharness-nightly < path/to/key.pem
   ```

   No `.pem` left? Generate a new private key on the App's page, store it this way, then delete the old key there.
2. After merge, once a sync run from `main` is green: the repository-level `FORK_BOT_CLIENT_ID`, `FORK_BOT_PRIVATE_KEY` and the old `FORK_BOT_TOKEN` secrets are deleted, and so is the `upstream-notify` environment (with your `gh` login). Revoke the `FORK_BOT_TOKEN` PAT at <https://github.com/settings/tokens> if it's still live.
3. Put a spending cap on the OpenRouter key.

## Verification

- `node --test selfhost/tests/*.test.ts`: the import body links the upstream PR and has no `Upstream:` line, the mirror body links the upstream issue, the `.github/` guard is unchanged, and the notify tests are gone.
- The sync's pause, as scripted git runs on real refs: a baseline before an upstream `.github/` commit pauses, the current one doesn't, and the flag goes past it.
- The environment refuses a branch (scratch branch test above).
- After merge, a real run from `main`: upstream sync (dispatch), issue mirror (dispatch), and Dependabot auto-merge on its next PR.
