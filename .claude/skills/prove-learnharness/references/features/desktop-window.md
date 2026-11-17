# Desktop window

The desktop app opens LearnHarness in its own window, backed by its own bundled server (packaged) or a dev server (dev shell), with the `window.lh` bridge for desktop-only features (folder picker, attachments by path, native updates, subscriptions).

## Sub-features

- `window`: the window opens on the app with `window.lh` present.
- `server-spawn` (packaged): the bundled server starts with the per-launch API secret; the window's requests carry it.
- `teach`: the teaching session works inside the window exactly as in a browser.

## How to get to it

- Packaged app (AppImage or deb on Linux; here `dist/linux-unpacked/learnharness`).
- `npm run desktop:dev` (dev shell on `next dev`; prove runs use the production head server instead).

## Driving it

Preconditions: the baseline (head instance running).

1. Dev shell: `E=$(scripts/electron.sh "$RUN" dev)` (about 3 s) -> `electron-dev/electron.log` says `window open: <head APP_URL>`.
   Packaged: `E=$(scripts/electron.sh "$RUN" packaged)` (about 10 s with Electron cached) -> `electron-packaged/package.log`, then `window open: http://127.0.0.1:<own port>`.
2. `node scripts/web-teach.mjs "$E"` -> first step "Electron window shows the app with the desktop bridge" (`{"bridge":"object","title":"Learning Harness"}`); packaged adds "fake model seeded from inside the window" (`[200,200,200]`); then the teaching-session steps.
3. Parity: `node scripts/compare.mjs "$RUN/head/web-teach/result.json" "$RUN/electron-<mode>/web-teach/result.json" --allow 'apiCalls=GET /api/updates 200' --allow 'apiCalls=GET /api/subscriptions 200'` (run the browser drive on `$H` first).

## Gotchas

- In packaged mode only the window can call the API (desktop secret), so the drive asks the window to fetch `/api/chats` and to seed.
- `--no-sandbox` is on while `ELECTRON_NO_SANDBOX=1`.
- `electron-builder --linux dir` writes `dist/linux-unpacked/` in the repo (gitignored).
