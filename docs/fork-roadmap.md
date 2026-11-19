# Fork roadmap

Future work for `max-miller1204/learnharness-nightly` that was considered while planning the self-hosted nightly server and deliberately **not built**. Each entry is a starting spec, not a commitment. An entry's number is a stable ID from the planning conversation (not a priority), so references to an item never change.

How to read an entry:

- **Decided** lists choices already made with the owner. Treat them as settled unless you reopen them on purpose.
- **Proposed design** is a starting point only. **Nothing in it is approved.** Settle the open questions with the owner before building.
- **Touches core** says whether the work edits app code. That's allowed: this fork is expected to change the core heavily, and upstream arrives only through a reviewed Sync PR. The note is there so you can judge how much each item adds to future Sync PR conflicts.

Baseline the entries build on (the self-hosting plan):
- Update logic lives in the server (`src/server/self-update.ts`, `/api/updates`, `/api/health`), and the sidebar update button and Settings row are shared with the desktop through a web transport.
- The separate `lh` launcher in `selfhost/` swaps versions, health-checks, rolls back and keeps snapshots.
- Versioned installs under `~/.learnharness/runtime/versions/`, and the `learnharness.service` systemd user unit.
- The server binds 127.0.0.1:3774, with optional Tailscale Serve on 8443.
- Upstream is mirrored hourly to `upstream-main` with a standing Sync PR. Upstream PRs and issues are hand-picked: the "Import upstream PR" and "Mirror upstream issues" workflows bring in one each (as the fork bot GitHub App), and each import or mirror links its upstream item by URL, so upstream's timeline shows a "mentioned this" entry (`docs/specs/upstream-handpicked.md`, `docs/specs/simplify-upstream-intake.md`). The fork bot's key is a secret of the `main`-only `fork-bot` environment, and the sync pauses when upstream changes `.github/`.

One structural rule carries over to every entry: **the launcher stays a separate process from the server.** It's what recovers from a broken version, so recovery logic must never depend on the server working.

## Desktop + distribution

### 2. Removing Electron

**Why.** A smaller repo and less to maintain if the fork only ever ships the server.

**Decided.** Not now, mainly to keep item 1 (Electron desktop nightlies, [docs/specs/electron-nightlies.md](specs/electron-nightlies.md)) possible.

**Proposed design (not approved).** Delete `electron/`, `electron-builder.yml`, `release.yml`, the `desktop:*` npm scripts and the desktop docs. Remove desktop-only branches in `src/` (`src/server/desktop-access.ts` desktop-secret path, the Electron transport in `useUpdateState`, subscription bridges that assume Electron main). In Sync PRs, upstream edits to deleted files show up as "you deleted it, they changed it" conflicts. Resolve those by keeping them deleted, or mark the paths `merge=ours` in `.gitattributes`.

**Open questions.** Is `merge=ours` acceptable, given it hides upstream's desktop changes?

**Touches core.** Yes (deletions plus removing desktop branches).

### 4. Docker image

**Why.** For hosts without systemd, NAS boxes, or people who prefer containers.

**Decided.** Dropped as the main path because a container can't use the host's `claude` program, its login or the host's Chromium. A Docker attempt was built and then reverted.

**Proposed design (not approved).** Build the image **from the same nightly tarball**: `FROM debian:bookworm-slim`, copy in `node/` and `server/`, add `chromium`, data on a `/data` volume. Push `ghcr.io/max-miller1204/learnharness-nightly:nightly` and `:<version>` for amd64 and arm64. Document that API-key and subscription providers work but CLI providers (Claude Code) don't, unless installed in the image.

**Open questions.** Should the container run `lh __service` (rollback, backups) or `server.js` directly and leave updates to the container platform? How should it be protected?

**Touches core.** No.

### 10. Side-by-side installs

**Why.** Run nightly and stable (item 11), or two nightlies, on one machine.

**Decided.** The first release uses one install: `~/.learnharness`, `lh`, `learnharness.service`.

**Proposed design (not approved).** Install-wide names come from a single "instance" setting: `lh --instance stable …` gives `~/.learnharness-stable`, `lh-stable` and `learnharness-stable.service`, with its own port (`lh up` picks the next free one) and Tailscale Serve port.

**Open questions.** Separate data per instance (sharing is risky because versions upgrade records in place)? Should the default instance keep the plain names?

**Touches core.** No.

### 11. Stable channel

**Why.** A slower, safer track: only builds that have run as nightlies for a while.

**Decided.** Not in the first release. T3 builds its stable releases from the commit of the latest published nightly.

**Proposed design (not approved).** A manual `promote-stable` workflow republishes a chosen nightly's tarballs as `v<version>-stable.<n>` and updates a fixed `stable` pointer release with its own `latest.json`. A channel picker in **Settings → Updates** (and `lh channel stable|nightly`) chooses which feed `self-update.ts` reads. Moving from nightly to an older stable is a downgrade, so it goes through the launcher's restore question.

**Open questions.** What makes a nightly eligible (age, manual pick)? Version scheme? Should the server ever downgrade on its own?

**Touches core.** Small (feed choice in `self-update.ts`, picker in the update settings).

---

## Access + security

### 5. LAN mode

**Why.** Reach the server from phones and laptops on home Wi-Fi without Tailscale.

**Decided.** Left out of `lh up` because with no login, anyone on the network gets full access.

**Proposed design (not approved).** `lh up --lan` binds `0.0.0.0` and prints the machine's LAN URLs. The app accepts IP-address Host headers. Optional: an mDNS name such as `learnharness.local`, which then goes into `LH_ALLOWED_HOSTS`.

**Open questions.** Is plain HTTP on the LAN acceptable (the session cookie would travel unencrypted), or is a locally trusted certificate needed?

**Touches core.** Small.

### 18. Signed releases

**Why.** `release.ts` checks each download's SHA-256 against `latest.json`, but both come from the same GitHub release. Anyone who can change the release can change both.

**Decided.** The first release uses SHA-256 only.

**Proposed design (not approved).** Pick one of two options:
- Sign `latest.json` and the tarballs with an Ed25519 key kept in CI secrets. `release.ts` and `install.sh` carry the public key and refuse anything unsigned.
- Use GitHub build provenance (`actions/attest-build-provenance`) and verify with `gh attestation verify`, which needs `gh` on the host.

Key rotation would ship a new public key inside a release signed by the old one.

**Open questions.** Which option? Is depending on `gh` on the host acceptable? What's the recovery plan if the key is lost?

**Touches core.** Small (`release.ts`, shared by the server and launcher).

---

## Files + ingestion

### 27. @-mentions for files and folders

**Why.** Typing `@` to pick a file is faster than the paperclip, drag-and-drop, or typing a full path.

**Facts.** T3 Code's design (MIT):
- Typing `@` opens a fuzzy search whose index lives **on the server** (`apps/server/src/workspace/WorkspaceSearchIndex.ts`, `WorkspaceEntries.ts`), with ignore patterns such as `.gitignore` (`IgnorePatterns.ts`).
- Picking a result inserts a mention segment that holds the path (`apps/web/src/composer-editor-mentions.ts`; menu in `apps/web/src/components/chat/useComposerMenuItems.ts`).

**Proposed design (not approved).**
- A server search endpoint over the folders you allow (the optional folder boundary, or a list of "places" in Settings), with the sensitive-path guard applied, `.gitignore`-style ignores, and result limits.
- In the composer, `@` opens a menu of matching files and folders; picking one inserts the existing path chip, so nothing downstream changes.
- Because the search runs on the server, browsers and phones can mention server files without typing paths. Files that exist only on the client need uploading.

**Open questions.** Which folders are searchable by default (home folder, chosen places, recent paths)? How should folders show versus files? Should results rank recently used paths first? Should `@` also mention other things, such as sessions or graph sources?

**Build outline.** Search endpoint with tests (guard, ignores, limits), the composer menu with keyboard navigation, chip insertion, then a check in a plain browser.

**Touches core.** Yes (new route, composer).

---

## Review workflow

### 28. Offering fork fixes upstream

**Why.** Picked upstream issues get fixed here first (`docs/specs/upstream-handpicked.md`). Those fixes could go back upstream as PRs.

**Decided.** Upstream can already find the fork's copy of each picked item through the link the import or mirror writes, which shows as a "mentioned this" entry on upstream's timeline (`docs/specs/simplify-upstream-intake.md`). This item is only about sending the fix itself upstream as a PR. Carried over from item 13 (upstream issue intake, [docs/specs/upstream-issue-mirror.md](specs/upstream-issue-mirror.md)).

**Open questions.** Offer fork fixes back upstream at all? As PRs from which branch, and who opens them?

**Touches core.** No.

---

## Ops + polish

### 8. Chromium on demand

**Why.** Demo verification needs a headless Chrome. The first release uses the host's browser and warns if there isn't one.

**Decided.** Detect the host browser and warn if missing.

**Proposed design (not approved).** `lh browser install` downloads a pinned Chrome for Testing build into `~/.learnharness/tools/chrome/<version>/`, checks its published hash and sets `CHROME_PATH`. `lh browser update` and `lh browser remove` manage it, like T3's `~/.t3/tools/cloudflared`.

**Open questions.** Chrome for Testing doesn't publish linux-arm64 builds, so Debian's `chromium` would be the fallback there. Should the browser update automatically?

**Touches core.** No.

### 14. Keep the machine awake during agent work

**Why.** A machine that sleeps mid-turn loses the turn. T3 holds a `systemd-inhibit --what=idle:sleep` lock while its agents work.

**Decided.** Not in the first release.

**Proposed design (not approved).** In the server, next to the idle logic in `self-update.ts`: when work starts (the same busy sources), spawn `systemd-inhibit --what=idle:sleep --who=LearnHarness --why="Agent is working" --mode=block tail --pid=<server pid> -f /dev/null`, and kill it when idle again. Only on self-hosted Linux. A `keepAwake` setting (default on) in Settings.

**Open questions.** Block on background jobs, or main turns only? Default on?

**Touches core.** Small.

### 15. Resource limits for agent processes

**Why.** Agent turns spawn `claude` and other processes inside the server's service. A runaway one can starve the machine or get the server killed by the out-of-memory killer. T3 runs each agent in its own systemd scope under an agents slice, with memory priorities and an `OOMScoreAdjust`.

**Decided.** Not in the first release.

**Proposed design (not approved).**
- Unit-level: `MemoryHigh`, `MemoryMax`, `CPUWeight` and `OOMPolicy=continue` on `learnharness.service`, set from `config.json`.
- Per-agent, in the app: spawn each CLI child through `systemd-run --user --scope --slice=app-learnharness-agents.slice -p MemoryHigh=… -p OOMScoreAdjust=…` (where the claude-code launch code starts the process). That keeps the server alive when a CLI child blows up. Applies to every CLI provider alike.

**Open questions.** Memory budget per agent? What happens when systemd isn't available (desktop, dev): plain spawn?

**Touches core.** Yes (the CLI spawn path).

### 17. Failure and conflict notifications

**Why.** If a nightly fails, a Sync PR conflicts, or an install rolls back, you only find out by looking.

**Decided.** First release: GitHub's own emails for failed workflows. The in-app rolled-back notice from the self-hosting plan covers the install side.

**Proposed design (not approved).**
- CI: on nightly failure, open or update one "Nightly failing" issue and close it on the next success. Optional webhook (`NOTIFY_WEBHOOK_URL`, e.g. ntfy or Discord).
- App: a notification center entry for "nightly failing upstream", read from the fork's release feed, plus browser notifications for update events when the tab allows them.

**Open questions.** Which channels? Notify on successful updates too?

**Touches core.** Small.

### 19. Scheduled and off-machine backups

**Why.** Snapshots only happen before an update switch, and they sit on the same disk as the data.

**Decided.** First release: a full copy before each switch, 3 kept.

**Proposed design (not approved).** `lh backup now` and a systemd timer for daily backups with retention (for example 7 daily and 4 weekly). The timer asks `/api/health` and waits for idle so files aren't caught mid-write. Optional off-machine target: an `rclone` remote or `restic` repository from `config.json`. Backups listed in Settings with a restore button that hands off to the launcher.

**Open questions.** Which tool and target? Encrypt? Should `auth.json` (API keys) ever leave the machine?

**Touches core.** No (Settings listing is optional).

---

## Plugins

Items about the plugin system and the people who write plugins.

### 29. Versioned plugin API package

**Why.** Outside plugin authors have no published plugin API to depend on. The SDK plugins depend on `"learnharness-plugin-api": "file:.sdk"`, a folder generated by `npm run sdk`, and each commits its generated `.sdk/package.json` so Dependabot can read it (see [docs/specs/dependency-updates.md](specs/dependency-updates.md)). That file declares the root's Pi versions exactly (and typebox's range) as peer dependencies, so a root-only Pi bump breaks the plugins' `npm ci` and Dependabot's `pi` PR arrives red until an agent finishes it.

**Decided.** Publish the plugin API (`learnharness-plugin-api`) as a versioned package for outside plugin authors. Approved by the owner as a future item. It replaces the committed `plugins/*/.sdk/package.json` files, and lets plugins accept a Pi peer range so Dependabot's `pi` PR can go green on its own.

**Proposed design (not approved).** None.

**Open questions.** All of the design: registry and package name/scope, versioning and compatibility policy, how the generated types are built and released, which Pi range plugins accept, and what happens to `.sdk/` and `npm run sdk`.

**Touches core.** Small (build and release scripts, plugin manifests; no app code expected).
