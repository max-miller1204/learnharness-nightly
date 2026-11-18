# Desktop window

The desktop app opens LearnHarness in its own window, backed by its own bundled server (packaged) or a dev server (dev shell), with the `window.lh` bridge for desktop-only features (folder picker, attachments by path, native updates, subscriptions).

## Sub-features

- `window`: the window opens on the app with `window.lh` present.
- `server-spawn` (packaged): the bundled server starts with the per-launch API secret; the window's requests carry it.
- `teach`: the teaching session works inside the window exactly as in a browser.
- `updater` (packaged AppImage): electron-updater against a local generic feed (`LH_UPDATE_FEED`): pill "available" with notes, Download, Install with the confirm dialog, re-check on Install, relaunch, What's new.

## How to get to it

- Packaged app (AppImage or deb on Linux; here `dist/linux-unpacked/learnharness-nightly`).
- `npm run desktop:dev` (dev shell on `next dev`; prove runs use the production head server instead).

## Driving it

Preconditions: the baseline (head instance running).

1. Dev shell: `E=$(scripts/electron.sh "$RUN" dev)` (about 3 s) -> `electron-dev/electron.log` says `window open: <head APP_URL>`.
   Packaged: `E=$(scripts/electron.sh "$RUN" packaged)` (about 10 s with Electron cached) -> `electron-packaged/package.log`, then `window open: http://127.0.0.1:<own port>`.
2. `node scripts/web-teach.mjs "$E"` -> first step "Electron window shows the app with the desktop bridge" (`{"bridge":"object","title":"Learning Harness"}`); packaged adds "fake model seeded from inside the window" (`[200,200,200]`); then the teaching-session steps.
3. Parity: `node scripts/compare.mjs "$RUN/head/web-teach/result.json" "$RUN/electron-<mode>/web-teach/result.json" --allow 'apiCalls=GET /api/updates 200' --allow 'apiCalls=GET /api/subscriptions 200'` (run the browser drive on `$H` first).

4. Updater (ran 2026-11-18, about 1 min per AppImage build): `dir` builds have no update feed on Linux, so build AppImages. For each version V (installed `...2`, offered `...4`, newer `...6`): copy `.next/standalone`, replace the baked version string (same length) in the copy, and run `npx electron-builder --linux AppImage --publish never --config <json>` with `extraMetadata.version=V`, `directories.output=$RUN/desk/out-V` and the `.next` extraResource pointed at the copy (check `pgrep -fc "next build"` first). Serve `$RUN/desk/feed/` over HTTP (a static server that logs every request), copy the offered AppImage and its `latest-linux.yml` there, appending `releaseNotes: |` with "### What's changed" bullets and a `<details>` block. Copy the installed AppImage to `$RUN/desk/install/LearnHarness.AppImage` and start it under `env -i` with `HOME`, `XDG_CONFIG_HOME` under the run, `DISPLAY` of an Xvfb you started, `LH_IGNORE_ENV_KEYS=1`, `LH_UPDATE_FEED=http://127.0.0.1:<port>/`, `APPIMAGE_EXTRACT_AND_RUN=1` (no FUSE here), `--no-sandbox --remote-debugging-port=<free>`. Then: the check 15 s after launch (main log), the pill and the feed log (no AppImage GET), click the pill (Download), quit through CDP `Browser.close` and relaunch (still the old version), Download again, publish the newer version, click the pill, Install and restart. The updater replaces the AppImage file and relaunches it without the CDP flag: write its pid file and screenshot the display (`import -window root`). `env -i` drops `APPIMAGE_EXTRACT_AND_RUN`, so pass it inside the `env -i` list.

## Gotchas

- In packaged mode only the window can call the API (desktop secret), so the drive asks the window to fetch `/api/chats` and to seed.
- `--no-sandbox` is on while `ELECTRON_NO_SANDBOX=1`.
- `electron-builder --linux dir` writes `dist/linux-unpacked/` in the repo (gitignored).
- AppImages need FUSE; without it set `APPIMAGE_EXTRACT_AND_RUN=1` (it extracts to `/tmp`, about 600 MB per running copy).
- A local static server without Range support makes electron-updater log "Cannot download differentially, fallback to full download": expected.
- The relaunched AppImage's main Electron process rewrites its `/proc/<pid>/environ` (Chromium's process title), so `pgrep` by the run's environment and `stop.sh`'s ownership check miss it (ran 2026-11-18): only its GPU child still shows the run. Find the main process by its extraction dir (`/tmp/appimage_extracted_<hash>`, the one created at the relaunch time) and its cwd, stop its process group (`kill -TERM -- -<pgid>`) yourself before `stop.sh`, then remove that extraction dir (killed AppImages leave it behind, about 600 MB of the /tmp tmpfs).
- Clicking the pill while Settings is open only closes Settings (backdrop click); the Download never starts. Close Settings first.
