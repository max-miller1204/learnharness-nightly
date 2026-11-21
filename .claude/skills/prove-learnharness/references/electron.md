# Electron desktop (Linux)

`electron/main.cjs` either opens a window on a running dev server (`LH_DEV_URL`, the dev shell, its own `<userData>-dev`) or, packaged, spawns `resources/server/standalone/server.js` on a free port with `LH_DESKTOP_SERVER=1` and a per-launch `LH_DESKTOP_API_SECRET`, injects that secret into every request of its window, and runs electron-updater.

## How a run drives it

`scripts/electron.sh "$RUN" dev|packaged` (needs `start.sh "$RUN" head` first):

- `env -i` (no ambient keys; `LH_IGNORE_ENV_KEYS=1`; HOME is `$RUN/electron-<mode>/home`), `xvfb-run -a` with a 1280x900 screen, `XDG_CONFIG_HOME=$RUN/electron-<mode>/config` (so `userData` is throwaway, never `~/.config/LearnHarness`), `--remote-debugging-port=<free>`, `--no-sandbox` while `ELECTRON_NO_SANDBOX=1`.
- dev: `node_modules/.bin/electron <repo>` with `LH_DEV_URL=<head APP_URL>`; shares the head server, data and fake model. The head server needs a login, so the window first shows its sign-in page: `electron.sh` copies the head's `APP_TOKEN` and `APP_PORT` into the window's `instance.env`, and `web-teach.mjs` sets that session cookie in the window before the drive.
- packaged: `npx electron-builder --linux dir --publish never` (unpacked, no AppImage or deb, nothing signed or published; about 10 s once Electron is cached), then `dist/linux-unpacked/learnharness-nightly`. The driver chooses the **This computer** tile (`#run-local`) on first launch. The app then runs its own bundled server with its own data under the throwaway config. The drive seeds the fake model from inside the window (`SEED_IN_PAGE=1`), since only the window carries the desktop session (it trades the per-launch secret for one at `/oauth/token`).
- Packaged, the first-run choice closes the list and opens the main window with the ghost dashboard: a second CDP page target at `electron/skeleton.html` (its own WebContents over the app window). It's gone once the app at `http://127.0.0.1:<port>` has loaded, so `page_url` still finds the app target. Relaunching the same profile saves the default, so no `server-list.html` target ever appears: only the skeleton, then the app. Run `electron.sh` with `LH_DEBUG_FIRST_FRAME=1` (it passes through) to log first-frame timings (`first-frame <ms> <event>` lines in `electron.log` and `userData/logs/main.log`) for a blank-frame report.
- Writes `$RUN/electron-<mode>/instance.env` with `CDP_URL`; `web-teach.mjs` attaches to that window instead of launching Chrome and runs the same teaching drive.

Parity answer key: `compare.mjs "$RUN/head/web-teach/result.json" "$RUN/electron-<mode>/web-teach/result.json" --allow 'apiCalls=GET /api/updates 200' --allow 'apiCalls=GET /api/subscriptions 200'`.

Update everything (the desktop app onto a self-hosted server, roadmap item 23 PR 2) needs AppImages, a tier B server and HTTPS: [features/update-everything.md](features/update-everything.md).

## Not covered on this machine

- macOS and Windows builds, signing, notarization and deb installs. `electron.sh` builds unpacked `dir` builds, which have no update feed (the log says "not an AppImage"); electron-updater moving between versions is driven by hand with AppImages: see [features/desktop-window.md](features/desktop-window.md) step 4.
- The renderer sandbox (`--no-sandbox`). Unlock: `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`, then `ELECTRON_NO_SANDBOX=0`.
