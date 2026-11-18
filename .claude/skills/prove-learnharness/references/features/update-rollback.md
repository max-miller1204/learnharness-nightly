# Self-hosted update and rollback

A self-hosted user gets new nightlies offered automatically: the server checks the feed (at start and every 4 hours while "Check for updates automatically" is on, or when the user clicks Check for updates / runs `lh update`), downloads in the background, and offers the version in the sidebar update pill and Settings > General. It installs only when the user clicks Install (pill or Settings, behind a confirm dialog that lists running work) or runs `lh update --now`; Install re-checks the feed first. The launcher snapshots data, trials the new version, keeps it when it reports ready, and rolls back by itself when it does not (the pill then shows a dismissible warning). After a switch, every open browser shows a one-time "What's new in X" popup built from the feed's `notes`. `lh rollback` and `lh use` switch back by hand. (Base builds before docs/specs/t3-style-updates.md still install a download by themselves when idle.)

## Sub-features

- `install`: `install.sh` installs a version and the systemd user service.
- `update`: feed has a newer version -> download -> switch -> committed.
- `snapshot`: a data backup named after the old version before each switch.
- `auto-rollback`: a version that fails its trial is rolled back and marked bad.
- `manual-rollback`: `lh rollback` returns to the previous version.
- `status`: `lh status` reports versions, service, health and the last update.
- `pill`: the sidebar update pill (`data-testid="update-pill"`, `data-action` install / dismiss-notice) and its release notes popover on hover (`update-pill-notes`).
- `confirm`: the Install confirm dialog (`install-update-dialog`, `install-update-cancel`, `install-update-confirm`) with the "Running now:" list from `GET /api/updates/running`.
- `install-recheck`: Install re-checks the feed and takes a newer version published after the download.
- `whats-new`: the one-time popup after a switch (`whats-new-dialog`, `whats-new-done`), remembered per server in `data/updates.json`.
- `rollback-notice`: after a failed trial the pill turns into a warning; clicking it dismisses it for every browser (`dismissedNotice` in `data/updates.json`).
- `toggle`: Settings > General "Check for updates automatically" (`[aria-label="auto update"]`); off means no check at start, `update-check` still finds, downloads and offers.

## How to get to it

- One-line installer (`install.sh`), `lh up`, `lh update [--now]`, `lh rollback`, `lh use <v>`, `lh status`, `lh restore`.
- Server: `/api/updates`, `/api/updates/check`, `/api/updates/install`, `/api/updates/running`, `/api/updates/notice/dismiss`, `/api/whats-new`, `/api/whats-new/seen`.
- Browser on the self-hosted server: the sidebar update pill (hover for notes, click to Install or to dismiss a rollback warning), Settings -> General (`settings-entry`, `settings-nav-general`, then `update-install` / `update-check` / the toggle), the What's new popup.

## Driving it

Preconditions: `scripts/build.sh "$RUN" both`; systemd user manager running; nothing else needed (no network).

1. `scripts/selfhost-a.sh "$RUN" base`, `scripts/selfhost-a.sh "$RUN" head`, `node scripts/compare.mjs "$RUN/base/selfhost-a/result.json" "$RUN/head/selfhost-a/result.json"` -> 33 launcher tests pass on both; every `lh` command refuses the same way in an empty home.
2. `scripts/selfhost-b.sh "$RUN"` -> `$RUN/selfhost/steps.log`, one line per step:
   - install A under `lh-prove-<id>.service` on a free port -> health on A.
   - session created on A.
   - update to B -> health on B, state `committed`; session kept; backup named after A.
   - broken C -> state `rolled-back` for C, health on B, C in `badVersions`, session kept.
   - `lh rollback --yes` -> health on A, `committed`, session kept.
   - real `learnharness.service` untouched.
3. Browser on the tier B install, head to head (ran 2026-11-18; needs extra head versions):
   - After step 2 the unit is on A. Make extra versions from B's archive by replacing the baked version string with one of the same length in `server/` and `VERSION` (e.g. `...20000101.4`, `.5` with `server/server.js` replaced by `process.exit(3)`, `.6`, `.7`), write each `<archive>.sha256`, and build each feed with the change's `node selfhost/scripts/make-feed.ts --version V --tag vV --sha zz-prove-it --repo zz-prove-it/learnharness --dir "$RUN/selfhost/feed" --notes notes-V.json --previous <previous feed>`, rewriting `assets.linux-x64.url` to `file://<archive>` before copying it to `$RUN/selfhost/feed/latest.json`. Notes files are `{version, publishedAt, items}`; give items `**Label.** detail` and chain `--previous` so the feed carries several versions.
   - Publish B's feed: the base server downloads and installs B by itself. Seed a model into the install (`node scripts/seed.mjs http://127.0.0.1:<port> <a fake model URL from this run>`), open two headless Chromes with their own profiles under the run (`--remote-debugging-port`, `--user-data-dir=$RUN/...`) on `/chat/new`, and drive them with puppeteer-core `connect`.
   - Publish `.4` (history `.3`, `.2`, `.1`), `lh restart` (the startup check), watch `/api/updates` reach `downloaded`; then read `[data-testid=update-pill]` in both browsers, hover it, open Settings > General, and poll `/api/health` + `service-state.json` every 15 s for 5 minutes.
   - Fake model `/__prove/fail?mode=hang`, send a goal in browser 1 (composer `[data-testid=composer] [contenteditable=true]`), click the pill: the dialog; Cancel; click again and Install and restart; wait for health on `.4` and `committed`; read both browsers before any reload; Got it in one, read the other; reload both.
   - Publish `.5` (broken), `lh update`, Install from Settings (`update-install`): rolled back; read both browsers, reload, hover and click the warning pill in one, read the other; `lh restart` and read again.
   - Toggle off, publish `.6`, `lh restart`, watch `/api/updates` and `runtime/downloads` for 2 minutes; Settings `update-check`; then publish `.7` and click Install: the re-check takes `.7`.
4. `scripts/stop.sh "$RUN"` removes the unit (and every process with a pid file under the run: write one for each browser you start).

## Gotchas

- The unit runs under the real systemd user manager with the real HOME; only `LH_HOME`, the unit name, port and bin dir are throwaway.
- With Automatic updates on (the default), the server may install B by itself as soon as it downloads; the script waits on state, not on its own command.
- `lh status` can fail for a moment during a switch (the shim is being rewritten); it is evidence, not a crash.
- Tier B (`selfhost-b.sh`) always takes `lh update --now` on the head; the browser drive in step 3 is by hand (no script yet).
- `/api/updates` changes reach an open browser over `/api/events`; after a server restart the stream reconnects with a backoff (about 20 s here), so poll the pill instead of reading it once.
- Read open browsers before reloading them: a reload hides what a user who kept the tab open sees.
- The user's real `learnharness.service` follows the real nightly feed and can update itself during a run; the tier B fingerprint then differs. Check `~/.learnharness/userdata/logs/update.log` (real versions, not `...20000101.N`) before blaming the run.
