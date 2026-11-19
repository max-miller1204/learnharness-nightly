# Update everything (desktop app onto a self-hosted server)

Roadmap item 23 PR 2 (answer key: [docs/specs/desktop-server-list.md](../../../../../docs/specs/desktop-server-list.md), PR 2, and [docs/specs/update-control.md](../../../../../docs/specs/update-control.md)). In the desktop app's window onto a paired self-hosted server, a newer app with the server behind it turns the sidebar button into a circle-arrow, "Update this app and 1 server". The app's own native dialog asks first. Then it downloads its update, asks the server for that exact version (`POST /api/updates/install-version`), waits until the launcher commits it, counts down 5 s (Later postpones) and restarts onto the same server.

## Sub-features

- `bridge`: the remote page has only `window.lh.desktopUpdate` (`getStatus`, `check`, `download`, `install`); the ghost page and other origins get nothing.
- `states`: `[data-testid=update-pill]` `data-action` `everything` (server behind), `app-download` / `app-install` (server already on it), disabled `everything` while a run goes.
- `settings`: Settings > General rows `row-version` ("Server X") and `row-desktop-app` ("This app Y", button `desktop-app-update`).
- `confirm`: the native "Update everything?" dialog with the running task count; Cancel changes nothing.
- `pinned`: the server installs exactly the app's version, even after a newer one is published mid-run.
- `commit`: the app waits for `committed: true` on `GET /api/updates`, not health alone.
- `answer`: the route answers 202 at once; `pinned` follows the staging. Drop the POST's answer (a proxy that closes the connection after forwarding it): the app keeps following the server.
- `failures`: refused (409), old server (404), rollback, 32-minute timeout, failed app download; the app stays on its version.
- `later`: Later reopens the updated server; the next click only restarts the app.
- `relaunch`: the app reopens the same server once (not the default), and says so when the app update didn't apply.
- `menu`: app menu Check for Updates… while connected: T3's native dialogs (on macOS only the message and detail show: Electron ignores `title` there, as for T3).
- `retry`: an app install refused after the server committed X: the notice offers Try Again, an app-only install of exactly X even after a newer version is published (no server request).

## Driving it (ThinkPad slot, by hand: no script yet)

Preconditions: [update-rollback.md](update-rollback.md) step 2 tier B install, and [desktop-window.md](desktop-window.md) step 4 AppImages. Keep 3 GiB free; each running AppImage extracts about 600 MB into `/tmp`.

1. Versions: one shared set `V1 < V2 < V3` made as in those recipes, each with a server archive and an AppImage built from the same head. Install `V1` on the server and the `V1` AppImage.
2. Server feed: lay it out as the real release does, `feed/nightly/latest.json` plus one `feed/v<V>/latest.json` per version (the server finds a pinned version beside the `nightly` pointer). Set the install's `LH_FEED_URL=file://$RUN/selfhost/feed/nightly/latest.json`. Turn the server's own automatic updates off so only the run moves it.
3. HTTPS: the desktop accepts only `https://` servers. Use Tailscale Serve on the test unit's port, or a local TLS proxy with a throwaway certificate trusted only in the run's environment.
4. Pair the AppImage (fresh profile, `LH_UPDATE_FEED` at the desktop feed serving `V2`) with `lh pair`, connect, and read `window.lh` through CDP on the server page (`Object.keys(window.lh)`, `Object.keys(window.lh.desktopUpdate)`).
5. Drive the button, Settings rows, Cancel, then Update everything. Publish `V3` to both feeds after confirming: the server must still go to `V2`. Poll `/api/health`, `GET /api/updates` (`committed`) and `service-state.json`; record when health first answers `V2` and when `committed` turns true; the app must not restart between them. Screenshot the ghost line "Updating <server> to V2…".
6. Failures, one fresh run each: an archive for `V2` with `server.js` replaced by `process.exit(3)` (rollback), the unit stopped (timeout: shorten nothing, record the 32-minute message, or check it in `tests/update-everything.test.ts`), a pre-PR server (404), a broken desktop feed (download failure: the server's `/api/updates` never sees a request).
7. Later, then the button again (only the app restarts). Restart: the app relaunches onto the same server even with another saved default; with the AppImage replaced back by `V1` before relaunch, the "didn't finish" notice shows once with Try Again and Later. Publish `V3` first, then Try Again: the app downloads and installs `V2` (not `V3`), with no server request (on a Mac, make Squirrel refuse the first ZIP with a wrong bundle identity to get there).
8. Menu: with the server page open and with it closed (problem screen), Check for Updates…: each T3 dialog.

## Gotchas

- `feed/latest.json` without the `nightly/` folder (the update-rollback recipe's layout) makes the pinned install fail with "Can't find version … next to the feed".
- The relaunched AppImage drops the CDP flag; find it as [desktop-window.md](desktop-window.md) says.
- `GET /api/updates` needs the bearer; read it with a session minted as in update-rollback.md, never with the desktop's own credential.
