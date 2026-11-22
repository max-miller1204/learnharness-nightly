# Web UI

The primary surface: the Next.js app served by the production standalone server (`.next/standalone/server.js`, what ships to self-hosted installs and inside the desktop app).

## How a run drives it

- **Browser:** puppeteer-core (an app dependency, so nothing to install) launching `/usr/bin/google-chrome` headless (`PROVE_CHROME`), with a per-side profile in `$RUN/<side>/chrome-profile` (removed by `stop.sh`). Viewport 1280x900.
- **Selectors:** `data-testid` first (`composer`, `question-dock`, `dock-overlay` (the bottom band holding either), `session-row`, `ctx-delete`, `delete-session-dialog`, `delete-confirm`, `setup-cta`, `settings-entry`, `new-session`, `new-session-practice`). The composer is `[data-testid="composer"] [contenteditable="true"]`. Question options are `[data-testid="question-dock"] [role="radio"]` (labels are the scenario's text, which is what is under test). Single-select options carry a letter badge, `[data-option-letter]` (since c3ff55ff), so an option's `textContent` is "ABlue": read the label without the badge with `readOptions`/`clickOption` in `scripts/question-options.mjs`. Submit is `[data-testid="question-dock"] form button[type="submit"]`. A sidebar folder's toggle is `button[data-testid="sidebar-folder-<id>"]`: a prefix match such as `[data-testid^="sidebar-folder-"]` also hits its wrappers (`sidebar-folder-row-<id>`, `sidebar-folder-branch-<id>`, `sidebar-folder-thread-<id>`), so match the button and the exact id. List more with `page.$$eval("[data-testid]", ...)`.
- **Waiting:** never `networkidle` (`/api/events` streams forever). Wait for a selector or a text with `waitForFunction`.
- **Session row menu:** right-click the row (retry: it can render before it is interactive), then `ctx-delete`, then `delete-confirm`. Rows have no id attribute, so each drive types a unique goal (`zz-prove-it <nonce> ...`) and matches on it.

## Budgets (answer keys in `budgets.json`)

`web-teach.mjs` measures on each page it drives and `compare.mjs` judges:

| Budget | How it is measured | Rule |
|---|---|---|
| Console errors | `console` events of type error plus uncaught page errors, with the resource URL | 0 beyond the known list (`/api/stt/token` 503 with no Deepgram key) |
| CLS | `PerformanceObserver` on `layout-shift` from page start (buffered), summed, input-driven shifts excluded; the reloaded session page is loaded 3 times (`clsSamples`); from Enter until the question page is measured the CPU runs 4x slower, and any shift sourced inside `dock-overlay` (outside its `stats-bar`) fails the drive step "no layout shift comes from the dock". Shifts within 500 ms of input never reach it, so `teach-read.json` holds the question back 1.5 s and the step also fails when the question dock mounted 1 s or less after Enter | `CLS_MODE=absolute` (the default): head median < 0.1. `relative`: head median <= highest base sample on the same page + 0.01 |
| Accessibility | axe-core `AXE_CORE_VERSION` injected from `.prove-it/tools/` (`scripts/ensure-axe.sh`) | no serious or critical rule id on a page that base does not also have |

Main's baseline before the first-load polish (docs/specs/polish-first-load.md), 2026-11-17: CLS about 0.27 on every page (the sidebar slid open on first load); axe `color-contrast` (serious) everywhere and `button-name` (critical) on a session page; console errors favicon 404 and the stt 503. That change fixes the first three.

To add a page to a drive, call the drive's `budgetsHere("<label>")` after the page settles, with the same label on base and head.

## Adding a drive for a new feature

Copy the shape of `scripts/web-teach.mjs`: same instance file, same `result.json` (`steps`, `observations`, `budgets`), so `compare.mjs` works unchanged. Put only base/head-comparable facts in `observations` (no ids, timestamps or nonces; normalize paths with the `<chat>` placeholder). Write the recipe in `features/` once it ran.

## Deleted sessions

`node scripts/web-delete.mjs "$H"` drives the single-session and folder delete dialogs while viewing a session. It also checks the graph's source delete with “delete sessions too” selected. The graph drive holds the browser's DELETE response and visits the cached session while the real server has already deleted it. Each case checks that the open view clears after success, then revisits an older entry with Back and asserts not-found, no transcript and no composer. The receipt `$RUN/head/web-delete.json` records every session API 404 from confirmation through the Back check. The answer keys are #343 and item 4 of `docs/specs/polish-first-load.md`.

## Typing before hydration

`node scripts/web-hydration.mjs "$B"` and then `"$H"` hold every `/_next/static` script request, type into the server-rendered composer while React has not attached, release the scripts, and read the field and the saved draft after hydration. It does that on a session without a saved draft, on a session with one, and on `/chat/new`. Its `observations` diff with `compare.mjs` like the other drives. Run it when a change touches `components/path-input.tsx`, `components/composer.tsx`, `lib/composer-drafts.ts` or how a field gets its first value (#366).
