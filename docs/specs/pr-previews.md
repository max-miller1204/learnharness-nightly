# PR previews

Status: approved by the owner on 2026-11-17. Roadmap item 12 ([fork-roadmap.md](../fork-roadmap.md#12-preview-builds-of-prs)).

Goal: try a PR on your own server before merging it, without touching your real install, its data or its updates.

Already decided by the owner (2026-11-17): previews run on fresh, empty data. The owner's PRs build a preview on their own; upstream imports and outside PRs only when the owner adds a label.

## What a preview is

- **A build attached to the PR.** One prerelease per PR, tag `preview-pr-<N>`, holding the linux-x64 and linux-arm64 archives, their `.sha256` files and the preview's own `latest.json`. Each new build replaces it. It never touches the `nightly` release's `latest.json`, so installs never see or offer it (T3 Code's manual-only preview channel).
- **Version** `<package version>-preview.<YYYYMMDD>.<run>`, the nightly's shape with `preview` in place of `nightly`, so the launcher's existing version, download and checksum code handles it unchanged.
- **Prerelease, not a draft.** T3 keeps previews as drafts, but a draft can only be downloaded with a token and the server has none.

## How you open it

- One bot comment on the PR, updated on each build: the commit it built, the version, the release link and the command.
- On the server: `lh preview <N>`. It downloads the build, checks its SHA-256 and runs it **in the foreground** beside your real server:
  - its own folder `~/.learnharness/previews/pr-<N>/` (build and data), fresh and empty: no learning data, no saved API keys (`auth.json`), no `service.env`. The Claude Code provider still works, since it uses this machine's `claude` and its login;
  - port 3775 (`--port N` to change), on `127.0.0.1` like the real server;
  - when Tailscale is on in `lh up`, also `https://<machine>:8444` (Tailscale Serve; shifted along with `--port`), removed again when the preview stops, or by the next `lh preview <N>` if it died;
  - it prints a pairing link and QR code for the preview, like `lh pair`;
  - no in-app updates: it isn't run by the launcher's supervisor, so the update button never appears.
- **Ctrl+C stops it** and deletes its folder. Run `lh preview <N>` again for a fresh one, or after a new build.

## When a preview builds

- **Your PRs** (author is the repository owner): on open, on every push and on reopen.
- **Everyone else's** (upstream imports, outside PRs, Dependabot): only when you add the **`preview`** label. Adding it approves the commit that is the head at that moment: only the build that your adding of the label started can publish. The label is removed once the preview is published, so a later push builds nothing until you add it again. This stops an outside author from swapping unreviewed code into a preview you already asked for.
- PRs that change only `docs/` or Markdown files never build one.

## Security

Adding `preview` to someone else's PR means "I've read this diff and I'm willing to run it on my server": a preview runs that PR's code as you.

The repository's secrets never reach PR code:

- **Build** (`.github/workflows/pr-preview.yml`, on `pull_request`): read-only token, no secrets referenced, no stored git credentials, cache scoped to the PR. It runs the same bundle job as the nightly (moved into a reusable `.github/workflows/selfhost-bundle.yml` that both call), so a preview gets the same build and smoke tests.
- **Publish** (`.github/workflows/pr-preview-publish.yml`, on `workflow_run`): always runs `main`'s copy and never checks out or runs PR code. It treats the build's files as data: exact file names, version shape, and checksums it computes itself. It publishes only when all hold: the PR is open, its head is the built commit, the build run was started by someone with write access (a fork PR's own workflow edits can't pass this), and the PR is the owner's, or it carries `preview` and that same person added `preview` at most 60 seconds before the run was created. The last check means a run started later by any other action (an edit, another label, which a fork's copy of the build workflow can listen to) can't publish a commit pushed after the label. The checks live in `selfhost/scripts/pr-preview-check.sh`, with tests. The archives are downloaded only after they pass. It uses the built-in token only (contents, PR comments, the label), never the fork bot App key.
- **Residual.**
  - "Started by" is the run's triggering actor, so re-running the run your label started rebuilds that same commit, and approving a first-time contributor's run within 60 seconds of labeling counts as asking for its preview.
  - A push in the seconds between your read and your click on the label is what gets built. The PR comment and `lh preview` name the commit.
  - Upstream imports are branches of this repository, whose runs could read secrets and raise their own token's permissions if their copy of a workflow asked. They can't, only because the import refuses `.github/` changes (fork-workflow.md).

## Cleanup

- When a PR is no longer open, its `preview-pr-<N>` release and tag are deleted: the publish workflow sweeps on every run, daily, and on a manual run. It deletes one only when GitHub says its PR is `closed`, so an API error never deletes an open PR's preview.
- On the server, nothing stays behind: the preview folder goes when it stops, and a folder, Tailscale port or server left by a crash (even of the launcher itself) is cleared on the next `lh preview <N>`.

## Chosen by the implementer (veto any)

| Topic | Choice |
|---|---|
| Arches | Both, as the nightly. |
| Release target | The tag points at `main`'s commit (it only holds files); the PR commit is named in the title, body and `latest.json`. Keeps outside commits out of the fork's tags. |
| Port | Real port + 1 (3775) and Tailscale port + 1 (8444). `--port` shifts the Tailscale port by the same amount, so two previews never share one. |
| Environment | Inherits the shell's environment like the service does, minus `service.env`. |
| Concurrency | A new push cancels that PR's older preview build. |

## Not in scope

- Switching your real install to a PR build (the roadmap's `lh use pr-<N>` and pinning). Previews run beside it instead.
- Copying your data into a preview.
- Background previews that outlive the terminal.
