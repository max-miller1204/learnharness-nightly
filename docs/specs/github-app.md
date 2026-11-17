# Fork bot GitHub App

Status: approved by the owner on 2026-11-17.

Goal: roadmap item 9. Replace the `FORK_BOT_TOKEN` personal access token in CI with a private GitHub App installed only on this fork. Every workflow mints a short-lived installation token through one shared step, so nothing expires and nothing is tied to the owner's account.

## Decided by the owner

1. App only, no PAT fallback. After the App works, the owner deletes the `FORK_BOT_TOKEN` secret.
2. Installed only on `max-miller1204/learnharness-nightly`.
3. One shared local composite action mints the token. Later workflows (upstream issue intake, PR previews) reuse it.
4. Permissions include **Workflows: Read and write**, so a mirror or import that carries upstream edits to `.github/workflows/*` isn't rejected. (Today's PAT lacks it; that was a latent gap.)
5. T3 style storage: both values are repository **secrets**, `FORK_BOT_CLIENT_ID` and `FORK_BOT_PRIVATE_KEY`, used with the action's non-deprecated `client-id` input.
6. The composite action mints the token and sets up `gh` and `git` auth for the rest of the job.
7. PR-Agent keeps skipping PRs sent by a bot. Sync and imported PRs get no automatic AI review; comment `/review` when wanted.

## Adopted from T3 Code (veto any)

- `actions/create-github-app-token` pinned by full commit SHA with a version comment: `64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0` (released 2026-10-12). T3 pins v2.2.2 the same way; v3 is the current major and the one that has `client-id`. Other actions in this repo stay on their major tags.
- Both App values as secrets (T3's `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`).
- Difference from T3: no `owner:` input. Leaving it out scopes the token to the current repository only (T3 passes `owner`, which covers every repo the App is installed on).

## Permissions (worked out from what the workflows do)

| Permission | Level | Why |
|---|---|---|
| Contents | Read and write | `git push --force` to `upstream-main` and `upstream-pr/<N>` |
| Pull requests | Read and write | `gh pr list/view/create/edit/close`, and the comment `gh pr close --comment` posts |
| Workflows | Read and write | Pushing commits that edit `.github/workflows/*` (owner decision 4) |
| Metadata | Read | Mandatory for every App; `gh repo view` |

Dropped from the PAT: **Issues**. No workflow touches issues or labels today, and PR comments only need Pull requests. Upstream issue intake (roadmap item 13) adds Issues when it lands; changing an App's permissions asks the owner to approve the change once.

No account permissions, no webhook, no event subscriptions. Reading upstream (`gh api repos/amosblomqvist/learnharness/pulls/N`, `git fetch` over HTTPS) is public and needs nothing.

## Design

### `.github/actions/fork-bot-token/action.yml` (new)

Inputs `client-id` and `private-key`, both required (a composite action can't read `secrets` itself, so callers pass them). Output `token`. Steps:

1. **Require the fork bot secrets.** If either input is empty, fail with `::error::Add the FORK_BOT_CLIENT_ID and FORK_BOT_PRIVATE_KEY secrets (docs/fork-workflow.md).`
2. **Mint** with `actions/create-github-app-token@<sha> # v3.3.0`, `client-id` and `private-key` only. The action masks the token and revokes it when the job ends.
3. **Use it for the rest of the job:** append `GH_TOKEN=<token>` to `$GITHUB_ENV` and run `gh auth setup-git`, so later `gh` calls and `git push` to github.com use the App token. This is the same job-wide exposure the PAT has today (job-level `GH_TOKEN`).

Callers:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
    persist-credentials: false
- uses: ./.github/actions/fork-bot-token
  with:
    client-id: ${{ secrets.FORK_BOT_CLIENT_ID }}
    private-key: ${{ secrets.FORK_BOT_PRIVATE_KEY }}
```

A local action only exists after checkout, so checkout comes first, with the read-only built-in token and `persist-credentials: false` (a saved `GITHUB_TOKEN` header would override the App credentials on push).

### `upstream-sync.yml` and `import-upstream-pr.yml`

- Remove the job-level `GH_TOKEN: secrets.FORK_BOT_TOKEN` and the "Require FORK_BOT_TOKEN" step; add the two steps above. The rest of each job is unchanged.
- Drop `ref: main` from checkout, so the workspace (the shared action, the import script) comes from the same commit as the workflow file. Scheduled runs and dispatches from `main` still check out `main`; the sync script compares against `origin/main` explicitly, so its behavior doesn't change. This also lets a dispatch from a PR branch test the branch's version, which is how this PR is verified.
- Header comments point at the App instead of the PAT.

These are the only two workflows that use `FORK_BOT_TOKEN` (checked with a repo-wide search).

### Triggering CI on bot PRs

Pushes and PRs made with an App installation token trigger workflows (only the built-in `GITHUB_TOKEN` is exempt), so `ci.yml` and the required `Check` still run on Sync and imported PRs. The PR author becomes `<app-name>[bot]`. PR-Agent skips them (decision 7).

### Docs

- `docs/fork-workflow.md`: replace the "FORK_BOT_TOKEN" section with "Fork bot (GitHub App)": the owner setup steps below, what the token can do, and that PR-Agent skips bot PRs. Add the action to "What lives where".
- `docs/fork-roadmap.md`: remove item 9 (its index row and section) since it's built, and change the baseline line to say the workflows authenticate as the fork bot App.
- `selfhost/scripts/import-upstream-pr.sh`: the comment says "the fork bot App token in CI" instead of `FORK_BOT_TOKEN`.

## Owner setup (manual, no manifest flow)

Plain UI steps instead of a manifest flow, so the private key goes straight from GitHub to the repo secret and never passes through an agent.

1. Open `https://github.com/settings/apps/new`.
2. **GitHub App name:** your choice (globally unique; PRs show it as `<name>[bot]`), for example `learnharness-nightly-bot`. **Homepage URL:** `https://github.com/max-miller1204/learnharness-nightly`.
3. **Webhook:** untick **Active**.
4. **Repository permissions:** Contents: Read and write; Pull requests: Read and write; Workflows: Read and write. (Metadata: Read is set automatically.) Nothing under Organization or Account permissions.
5. **Where can this GitHub App be installed?** Only on this account. Click **Create GitHub App**.
6. On the App's page, copy the **Client ID**. Under **Private keys**, click **Generate a private key**; a `.pem` downloads.
7. **Install App** (left menu) → your account → **Only select repositories** → `learnharness-nightly` → Install.
8. Store both as secrets:
   ```sh
   gh secret set FORK_BOT_CLIENT_ID -R max-miller1204/learnharness-nightly   # paste the Client ID
   gh secret set FORK_BOT_PRIVATE_KEY -R max-miller1204/learnharness-nightly < ~/Downloads/<app-name>.<date>.private-key.pem
   ```
   Then delete the `.pem` (or move it to a password manager). A lost key is replaced by generating a new one on the App page.

## Verification

1. `gh api /user/installations` shows the App installed on this repo only, with exactly the permissions above.
2. Dispatch **Upstream sync** from this PR's branch: the token mints, the mirror push authenticates, and the run ends as today ("main already contains upstream" while that holds).
3. Dispatch **Import upstream PR** from this PR's branch with small upstream PR 757 (3 files, no workflow changes): `upstream-pr/757` is pushed, a fork PR opens authored by the App, and CI including `Check` starts on it. Run it again to prove the update path. Then close that PR and delete its branch (unless the owner wants to keep it).
4. CI `Check` green on this PR; one independent review round; a `prove-learnharness` run (a CI-only diff reaches no app surface; prove says so).
5. After merge, the next scheduled sync on `main` succeeds. Then it's safe to delete `FORK_BOT_TOKEN`.

Not proven live: a push that edits workflow files (no open upstream PR touches them). Step 1 confirms the permission is granted.

## Out of scope

Issues permission (item 13), PR previews (item 12), any change to PR-Agent, CI or the nightly.
