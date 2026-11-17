# Spec: updates work like T3 Code, plus What's new

Status: approved by the user, 2026-11-17.
Base: main at 42ae045. Roadmap item 7 ("Update deadline"), reworked by the user.
T3 Code reference: github.com/pingdotgg/t3code at 54ad956 (MIT). Ported pieces keep T3's MIT notice in a header comment.

## What main does today

- Self-hosted server (`src/server/self-update.ts`): checks at start and every 15 minutes, downloads in the background, then applies the staged version on its own the first time nothing is running (checked every 30 s). Once a version is staged it stops checking, so a newer nightly is never picked up until the staged one installs. "Restart" applies at once.
- Desktop (`electron/main.cjs`): checks at launch and every 24 hours, downloads on its own (`autoDownload`), installs on quit (`autoInstallOnAppQuit`), "Restart" quits and installs.
- UI: a fixed bottom-right card (`components/update-banner.tsx`) for "ready", "Updated to X" and "rolled back". Settings > General has the Version row and an "Automatic updates" toggle (`general.autoUpdate`).
- Notes: the nightly release body is a plain commit list. `latest.json` has no notes, so the app never sees any. Nightlies prune to the newest 30 releases.

## Decided by the user (brief)

Server: check at start, then every 4 hours; download in the background; the toggle becomes "Check for updates automatically" (checking and downloading only); apply only on click, behind a confirm dialog that lists the running work. Desktop: match T3 (check 15 s after launch then every 4 hours, download only on click, never install on quit, Install confirms and first re-checks for a newer build). UI: sidebar pill that stays until acted on, plus the Settings row, no toast. Pill shows T3-style release notes. One-time "What's new in X" popup after an update, last seen remembered per server. Notes generated in nightly.yml with an AI summary through OpenRouter, falling back to the plain commit list. Out of scope: stable channel (item 11), desktop nightly publishing (item 1), mobile.

Answers to my questions: the rollback notice becomes a pill warning state (hover shows the text, click dismisses it, remembered per server; the Settings row also shows it). The What's new popup runs on desktop too, through the same mechanism. With no notes for the new version, the popup still shows ("Updated to version X." plus Read more).

## Changes

### 1. Shared shapes

- `ReleaseNoteGroup = { version: string; releasedAt?: string; items: string[] }`. `items` are plain sentences; an item shaped `**Label.** detail` renders the label bold (T3's convention). At most 8 items per group, each at most 220 characters (T3's limits).
- `UpdateState` (desktop and web) gains `"available"` in `status` (desktop only: found, not downloaded), `releaseNotes: ReleaseNoteGroup[]` (newest first, versions newer than the running one up to the offered one, at most 6 groups) and `omittedReleaseCount: number` (groups beyond 6). Both default to empty.

### 2. Notes at release time (nightly.yml, `scripts/generate-release-notes.ts`)

- New script, run with plain `node` (erasable TypeScript, built-ins plus `gh`, no new dependencies). Inputs: `--repository --tag --ref --previous-tag --version --output`. It reads `git log --no-merges previous..ref` (everything on main, including imported upstream changes), and the bodies of the PRs those subjects name (`gh api graphql`, trimmed to 300 characters as T3 does), and asks OpenRouter (`https://openrouter.ai/api/v1/chat/completions`, model `OPENROUTER_MODEL` or `anthropic/claude-haiku-5.5`, JSON output, reasoning effort low, 3 minute timeout).
- Prompt: T3's `SUMMARY_INSTRUCTIONS` adapted to LearnHarness (web app, desktop and self-hosted server; up to 7 user-facing highlights; skip internal work, docs, tests, CI and dependency bumps; group commits with the same outcome; zero is allowed; short label plus one sentence of at most 20 words; no headings, PR numbers, hype or em dashes). The model returns `{ highlights: [{ label, detail, commits }] }`; commit numbers must point at real input commits or the whole result is rejected (T3's check).
- Items: one `**Label.** detail` per highlight, then, if fix/perf commits were left out, one last item counting them ("Plus 3 more bug fixes.", T3's wording and pluralisation). No highlights and no fixes: no items.
- It writes `notes.json` (`{ version, publishedAt, items }`) and nothing on failure. The workflow step runs with `continue-on-error: true` and `OPENROUTER_API_KEY` from secrets.
- Fallback (next step, when `notes.json` is missing): items are the commit subjects of the range, newest first, with a trailing ` (#N)` removed, first 8.
- Release body (`notes.md`): "### What's changed" plus the items as bullets (omitted when there are none), then a folded `<details><summary>Full changelog</summary>` holding today's commit list, then today's build and install lines. The desktop parser below cuts at `<details>`, as T3's does.
- `latest.json` gains `notes: [{ version, publishedAt, items }]`, newest first: this release's entry, then the entries from the previous `latest.json` on the `nightly` release, deduped by version, newest 30 kept (the same 30 the prune keeps, so every listed version still has a live release page). `make-feed.ts` gets `--notes <notes.json>` and `--previous <latest.json>`.
- `parseFeed` accepts the field and drops malformed entries instead of failing; old launchers and servers ignore it. The `feed-check.yml` repair copies a release's `latest.json` as today, notes included.

### 3. Self-hosted server updater (`src/server/self-update.ts`)

- Checks at start (when the toggle is on) and every 4 hours (`CHECK_INTERVAL_MS`). The toggle still gates automatic checks only; Check for updates always works.
- Download stays automatic in the background when a check finds a newer version.
- No automatic apply: the idle loop (`IDLE_POLL_MS`, `scheduleIdleApply`) is removed. Applying happens only through `install()` (the Install button, POST `/api/updates/install`, `lh update --now`).
- Checks keep running while a version is ready: a newer nightly is downloaded and then replaces the ready one (the older one stays offered until the newer one is fully staged). `install()` first re-checks the feed (T3's "a download can be hours old" rule), installs the newer version if one appears and stages, and otherwise installs the ready one; a failed re-check installs the ready one.
- Notes: on each successful check the state's `releaseNotes` and `omittedReleaseCount` come from the feed's `notes`, filtered to versions newer than the running one and not newer than the feed's version. Each check also merges the feed's notes into the notes cache (section 6).
- Notices: the "updated" notice and `UPDATED_NOTICE_MS` go (What's new replaces them). The rolled-back notice stays and is now dismissible per server: POST `/api/updates/notice/dismiss` records its id (`rolled-back:<version>:<at>`) in the updates record (section 6); a dismissed notice is not adopted again at boot.
- `appIsIdle()` and `/api/health`'s `idle` stay (the launcher's own protocol hand-off and `lh status` use them).
- New `runningWork()` (the same sources as `appIsIdle`) and GET `/api/updates/running` → `{ items: [{ kind, title }] }` with kind `turn`, `compaction`, `job`, `plugin-worker` or `extraction`, and the chat, job, worker or extraction title.
- `lh update` (no `--now`) text: "It installs when you click Install in the app, or run `lh update --now`."

### 4. Desktop updater (`electron/main.cjs`, `electron/preload.cjs`)

- `autoDownload = false`, `autoInstallOnAppQuit = false`, `fullChangelog = true`.
- Automatic checks: 15 s after launch, then every 4 hours, gated by the toggle as today. Manual checks unchanged.
- `update-available` sets `available` with the version and notes (no download). New IPC `lh:update:download` (preload `downloadUpdate()`) calls `downloadUpdate()`; progress shows `downloading`; done shows `downloaded`.
- Install (`lh:update-install`): first re-checks; when the feed offers a version newer than the downloaded one, downloads it, then installs that one; otherwise installs the downloaded one. Before quitting it saves the installed version's notes to the notes cache (section 6) and kills the server first, as today.
- Notes: `electron/release-notes.cjs`, a port of T3's `apps/desktop/src/updates/releaseNotes.ts` (HTML/markdown stripping, `<details>` cut, 6 groups, 8 items, 220 characters), turns electron-updater's `releaseNotes` (string or per-version array) into `ReleaseNoteGroup[]`, dropping T3's intro/stats/footer extras and channel filter.
- The rule "a later check must not hide a staged update" stays.

### 5. UI

**Sidebar pill** (`components/sidebar-update-pill.tsx`, adapted from T3's `SidebarUpdatePill` and `SidebarUpdateReleaseNotes`). A round icon button at the right end of the sidebar's Settings row (T3's size-8 icon button, no text; its label is the tooltip text). Shown only when there is something to act on:

| State | Icon | Hover | Click |
|---|---|---|---|
| desktop `available` | download arrow | release notes popover, title "Update ready to download" | starts the download |
| `downloading` | spinner | "Downloading update" | nothing (disabled) |
| `downloaded` | arrow-up-circle | release notes popover, title "Update X downloaded. Click to restart and install." | the confirm dialog |
| rolled-back notice, no update | warning triangle | the rollback text | dismisses the notice |

Otherwise hidden (checking and up-to-date live in Settings). Hidden when the sidebar is closed (it is part of the sidebar, as in T3).

Release notes popover (T3's content): opens on hover or keyboard focus with a 150 ms close delay, stays open while hovered so the links work. One section per group: the newest group's heading is "What's changed", others "Changes in X"; bullets; a "Read more" link to `<homepage>/releases/tag/v<version>`; when groups were cut, "N older releases on GitHub" linking to `<homepage>/releases`. With no notes the hover shows only the title line, as a tooltip.

**Confirm dialog** (`components/install-update-dialog.tsx`, HostDialog, the abort dialog's minimal tone). Title "Install update X and restart LearnHarness?". Line "Any running tasks will be interrupted. Make sure you're ready before continuing." (T3's wording). When GET `/api/updates/running` returns items, a list headed "Running now:" with one line per item ("Chat turn: <title>", "Compaction: <title>", "Background job: <title>", "Plugin worker: <title>", "Extraction: <title>"); fetched when the dialog opens. Buttons Cancel and "Install and restart" (focused). Opened by the pill and by the Settings Install button, on both transports.

**Settings** (`components/settings/update-settings.tsx`): the button is "Download" for desktop `available`, "Install" (was "Restart") for `downloaded` (opens the confirm dialog), otherwise "Check for updates". Texts:
- Toggle label "Check for updates automatically". Hint, web: "Check at startup and every 4 hours, and download new versions in the background. Nothing installs until you click Install." Desktop: "Check 15 seconds after launch and every 4 hours. Nothing downloads or installs until you click."
- Version row hint, web: "Check for updates downloads a newer version. It installs when you click Install." Desktop: "Check for updates looks for a newer version. Download and Install happen when you click them."
- Status: `available` "Version X is available."; `downloaded` "Version X is ready to install." (both transports); others unchanged.

**Removed**: `components/update-banner.tsx` and its mount in `app/layout.tsx`.

### 6. What's new popup

- Data, in the data folder (`config.ts` data root, so "per server": every browser on that server sees the same thing):
  - `release-notes.json`: the notes cache, `{ groups: ReleaseNoteGroup[] }`, newest 30 versions. Written by the self-hosted updater on each check and by Electron main before installing.
  - `updates.json`: `{ lastSeenVersion?: string; dismissedNotice?: string }`, written atomically.
- GET `/api/whats-new` → `{ version, groups, omittedReleaseCount } | null`. Null when the running version is not an exact version (dev builds), or equals `lastSeenVersion`. With no `lastSeenVersion` (fresh install, or the first build with this feature) it records the running version and returns null, so nobody gets a popup for an install. Groups: cached groups with `lastSeen < version <= running`, newest first, at most 6, same limits.
- POST `/api/whats-new/seen` `{ version }` records it and emits `whats-new-changed`; every open client refetches, so seeing it on one device closes it on the others.
- Popup (`components/whats-new-dialog.tsx`, HostDialog, mounted in the layout where the banner was): title "What's new in X"; the same sections as the pill popover (shared renderer); with no groups the body is "Updated to version X." and a Read more link to that release. One button "Got it". Any dismissal (button, Esc, backdrop) marks it seen.

### 7. Docs

`docs/self-hosting.md` Updates section and the `lh update` table row, `docs/desktop-release.md` where it describes install on quit, and roadmap item 7 marked done with a pointer here. No skill changes unless the prove run needs a new probe.

## Done looks like

1. Server, tier B: a self-hosted install sees a newer version, downloads it, shows the pill and Settings "Install"; nothing installs on its own, even when idle for minutes. Hovering the pill shows the notes from `latest.json` (newest "What's changed", older "Changes in X", Read more links). Install opens the dialog listing a running chat turn; Cancel keeps everything; Install and restart switches versions. After the switch the "What's new in X" popup appears once; Got it on one browser closes it on a second and it never returns after reload. A rolled-back trial shows the warning pill; clicking it dismisses it for every browser.
2. Toggle off: no automatic check or download; Check for updates still finds, downloads and offers.
3. Desktop, packaged, against a local `LH_UPDATE_FEED`: no download before the click (pill "available" with notes), Download then Install with the dialog, quitting without Install leaves the old version, Install re-checks and takes a newer build published after the download, and the What's new popup shows after relaunch.
4. Workflow: `generate-release-notes.ts` produces items from a real range with a key, and the fallback produces the commit list without one; `make-feed.ts` merges and caps the notes history; an old `parseFeed` input without `notes` still parses.
5. CI `Check` green.

## Not changed

Feed URL, the launcher's trial, commit and rollback, `lh update --now`, update channels, desktop publishing, mobile.
