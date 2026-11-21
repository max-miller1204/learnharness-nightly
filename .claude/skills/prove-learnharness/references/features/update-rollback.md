# Self-hosted update and rollback

A self-hosted user gets new nightlies offered automatically: the server checks the feed (15 s after start and every 4 hours, with no toggle, or when the user clicks the check button / runs `lh update`) and offers the version ("available") in the sidebar update pill and Settings > General. It downloads only when the user clicks Download (pill or Settings, `POST /api/updates/download`), and installs only when the user clicks Install (pill or Settings, behind T3's confirm dialog) or runs `lh update --now` (which downloads first); Install re-checks the feed first. (Base builds before docs/specs/t3-style-updates.md revision PR 5 download in the background and have the "Check for updates automatically" toggle.) The launcher snapshots data, trials the new version, keeps it when it reports ready, and rolls back by itself when it does not (the pill then shows a dismissible warning). After a switch, every open browser shows a one-time "What's new in X" popup built from the feed's `notes`. `lh rollback` and `lh use` switch back by hand. (Base builds before docs/specs/t3-style-updates.md still install a download by themselves when idle.)

## Sub-features

- `install`: `install.sh` installs a version and the systemd user service.
- `update`: feed has a newer version -> download -> switch -> committed.
- `snapshot`: a data backup named after the old version before each switch.
- `auto-rollback`: a version that fails its trial is rolled back and marked bad.
- `manual-rollback`: `lh rollback` returns to the previous version.
- `status`: `lh status` reports versions, service, health and the last update.
- `pill`: the sidebar update pill (`data-testid="update-pill"`, `data-action` install / dismiss-notice) and its release notes popover on hover (`update-pill-notes`).
- `confirm`: the Install confirm dialog (`install-update-dialog`, `install-update-cancel`, `install-update-confirm`) with T3's text and no list of the running work (owner, 2026-11-20; docs/specs/t3-style-updates.md revision PR 3).
- `install-recheck`: Install re-checks the feed and takes a newer version published after the download.
- `whats-new`: the one-time popup after a switch (`whats-new-dialog`, `whats-new-done`), remembered per server in `data/updates.json`.
- `rollback-notice`: after a failed trial the pill turns into a warning; clicking it dismisses it for every browser (`dismissedNotice` in `data/updates.json`).
- `offer`: a check sets "available" and downloads nothing; Download (`update-pill` `data-action="download"`, or Settings' `update-button` reading Download) stages it; a broken package keeps the offer with "Download failed for X. Click to retry.".
- `settings`: Settings > General's one `update-button` (T3's About button) goes through Check for Updates, Checking…, Up to Date, Download, Downloading…, Install, with `update-description` reading "Update available." or "Current version of the application."; a stored `general.autoUpdate: false` changes nothing.

## How to get to it

- One-line installer (`install.sh`), `lh up`, `lh update [--now]`, `lh rollback`, `lh use <v>`, `lh status`, `lh restore`.
- Server: `/api/updates`, `/api/updates/check`, `/api/updates/download`, `/api/updates/install`, `/api/updates/running`, `/api/updates/notice/dismiss`, `/api/whats-new`, `/api/whats-new/seen`.
- Browser on the self-hosted server: the sidebar update pill (hover for notes, click to Install or to dismiss a rollback warning), Settings -> General (`settings-entry`, `settings-nav-general`, then `update-button`), the What's new popup.

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
   - Publish B's feed: the base server downloads and installs B by itself. Every request needs a login since docs/specs/login-pairing.md (ran 2026-11-18): mint one session per client into the install's login store with `node -e 'import("<repo>/selfhost/src/auth-store.ts").then((m) => console.log(m.issueSession("<LH_HOME>/userdata/data", { method: "cli", client: { label: "zz-prove-it b1", deviceType: "bot" } }).token))'` (keep the token in a 0600 file under the run, never in evidence). Seed a model into the install (`APP_TOKEN=<token> node scripts/seed.mjs http://127.0.0.1:<port> <a fake model URL from this run>`), open two headless Chromes with their own profiles under the run (`--remote-debugging-port`, `--user-data-dir=$RUN/...`), set the cookie `lh_session_<port>=<token>` (`page.setCookie`, httpOnly, sameSite Lax) before loading `/chat/new`, and drive them with puppeteer-core `connect`. `curl` calls to `/api/updates*` and `/api/whats-new*` send `Authorization: Bearer <token>`; `/api/health` stays public.
   - Publish `.4` (history `.3`, `.2`, `.1`), `lh restart` (the startup check, 15 s after start), watch `/api/updates` reach `available` and `runtime/downloads` stay empty, click Download (pill or Settings `update-button`) and watch it reach `downloaded`; then read `[data-testid=update-pill]` in both browsers, hover it, open Settings > General, and poll `/api/health` + `service-state.json` every 15 s for 5 minutes.
   - Fake model `/__prove/fail?mode=hang`, send a goal in browser 1 (composer `[data-testid=composer] [contenteditable=true]`), click the pill: the dialog; Cancel; click again and Install and restart; wait for health on `.4` and `committed`; read both browsers before any reload; Got it in one, read the other; reload both.
   - Publish `.5` (broken), `lh update` (it prints `available` and how to download), Install from Settings (`update-button` reading Install; it downloads first): rolled back; read both browsers, reload, hover and click the warning pill in one, read the other; `lh restart` and read again.
   - Write `"general": { "autoUpdate": false }` into the install's `settings.json` (an old toggle), publish `.6`, `lh restart`: the startup check still offers `.6` and Settings shows no toggle; Download it, then publish `.7` and click Install: the re-check takes `.7` (downloading it first).
4. `scripts/stop.sh "$RUN"` removes the unit (and every process with a pid file under the run: write one for each browser you start).

## Gotchas

- The unit runs under the real systemd user manager with the real HOME; only `LH_HOME`, the unit name, port and bin dir are throwaway.
- With Automatic updates on (the default), the server may install B by itself as soon as it downloads; the script waits on state, not on its own command.
- `lh status` can fail for a moment during a switch (the shim is being rewritten); it is evidence, not a crash.
- Tier B (`selfhost-b.sh`) always takes `lh update --now` on the head; the browser drive in step 3 is by hand (no script yet).
- `/api/updates` changes reach an open browser over `/api/events`; after a server restart the stream reconnects with a backoff (about 20 s here), so poll the pill instead of reading it once.
- Read open browsers before reloading them: a reload hides what a user who kept the tab open sees.
- Under memory pressure (other agents building) the reconnect took 25 to 40 s (ran 2026-11-18): poll each open browser every few seconds for at least a minute after the server is back before calling a pill stale.
- Settings' "Version X" row is baked into the client bundle (`APP_VERSION`). Versions repacked from B's archive keep B's chunk file names, so a browser that cached them keeps showing B's number after a switch. That comes from repacking, not from the app: read the running version from `/api/health`.
- The user's real `learnharness.service` follows the real nightly feed and can update itself during a run; the tier B fingerprint then differs. Check `~/.learnharness/userdata/logs/update.log` (real versions, not `...20000101.N`) before blaming the run.
- New-route refusals under login (ran 2026-11-18): a bearer token skips the Origin check and a foreign Host is allowed (login-pairing spec, "Security trade-off"), so probe the four new routes with no credential (401), a forged bearer (401) and the session cookie plus a cross-site `Origin` (and `Sec-Fetch-Site: cross-site`) (403), and check `updates.json` is unchanged by them; a bearer-only cross-site probe answers 2xx by design.
- Clicking the pill while the Settings dialog is open only closes the dialog (the click lands on its backdrop): close Settings first, then click the pill.
