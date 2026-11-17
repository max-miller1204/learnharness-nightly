# Spec: first-load polish (layout shift, favicon, accessibility, delete 404)

Status: approved by the user, 2026-11-17.
Base: main at 87a8866. Findings below come from a `prove-learnharness` run on that commit (fresh Chrome profile, 1280x900, Default theme).

## What main does today (measured)

| # | Finding | Evidence on main |
|---|---|---|
| 1 | Layout shift on first load | CLS 0.2682 on `/chat/new`, 0.2682 on a session with a question card, 0.2654 on a reloaded session. The server renders the sidebar closed (`useState(false)`), the mount effect reads `lh:sidebar-open` (default open) and opens it in the same commit that turns the width transition on, so the sidebar animates 0 to 288 px and slides the main pane with it. |
| 2 | No favicon | `GET /favicon.ico` answers 404 on every page (console error). |
| 3a | axe `button-name` (critical) | The coverage ring button (`data-testid="coverage-ring"`) in a session header has no accessible name; its only label is the hover tooltip "How much of this session isn't mapped yet". |
| 3b | axe `color-contrast` (serious) | Four nodes, all 11 px text needing 4.5:1: the sidebar "Sessions" label (#696969 on #141414, 3.35:1), the "Background agents" header (#696969 on #141414, 3.35:1), the composer's "Dictate" button text (#6a6a6a on #181818, 3.28:1), and the meta line ("Waiting for input · just now") of the selected session row (#8d8d8d on #2a2a2a, 4.32:1). |
| 4 | Delete the session you are viewing: console 404 | Reproduced 4 times in 15 tries: `GET /api/chats/<id> 404` after confirming delete. The request comes from the chat view's turn-start record re-reads (timers at 400 ms, 1 s, 2 s after a turn starts, `components/chat.tsx`); the probe notes also record a `GET /api/chats/<id>/side-chats` 404 variant. Cause: after the DELETE succeeds the sidebar calls `router.push("/")`, but the chat view stays mounted until that navigation commits, and its timers and listeners keep fetching the deleted session in that gap. |

## Changes

### 1. Sidebar renders in its final state on first load

Approach (from the Next.js guide "Preventing flash before hydration", `node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md`, and T3 Code's `apps/web/index.html` boot script, which applies stored UI state before first paint):

- A small inline script in the root layout's `<head>` runs before first paint. It reads `localStorage["lh:sidebar-open"]` and sets `data-lh-sidebar="closed"` on `<html>` when the stored value is `"0"`, or when the page runs in Electron and `window.innerWidth < 928` (the existing narrow auto-close rule). Otherwise it leaves the attribute off (open, the existing default). Wrapped in try/catch; with storage unavailable the sidebar renders open.
- The sidebar's open/closed look is driven by that attribute through a Tailwind custom variant (`sidebar-closed:`) instead of React-state class names, for the three places that depend on it: the sidebar width (`w-72` / `w-0`), the header's open-sidebar toggle slot and button, and the plugin graph action rail's top offset. The two macOS Electron gutter rules (`.lh-closed-toggle`, `.lh-plugin-graph-closed`) are scoped to the closed attribute the same way. The server HTML is then identical for everyone and needs no hydration exception beyond the one `<html>` already has.
- `SidebarProvider` keeps the attribute in sync with its state (`open && !narrow`) in a layout effect, so toggles (button, Cmd+B, Cmd+Shift+F search, narrow auto-close and auto-restore) work as today. Its initial React state becomes open (the default), then the mount effect reads storage as today.
- The open/close animation stays for user toggles: transitions stay gated on mount, and on first load nothing changes width after mount, so nothing animates.
- Persistence is unchanged: same `lh:sidebar-open` localStorage key, same default (open), same narrow behaviour.

Done looks like: CLS < 0.1 on every page the prove drive measures (`/chat/new`, a session with a question card, a reloaded session, each in a fresh profile), with the sidebar open by default; a stored closed sidebar also loads closed with no shift; clicking the toggle still animates open and closed.

Skill change: `CLS_MODE` in `.claude/skills/prove-learnharness/scripts/knobs.env` flips to `absolute` (CLS < `absoluteMax` 0.1). The skill text that calls relative mode temporary and the "main already fails absolute CLS" gotcha are updated to match. `scripts/compare.mjs` read `CLS_MODE` only from the environment (default `relative`), so it now falls back to the `knobs.env` default; a real env var still wins.

### 2. Favicon

- Add `app/favicon.ico`, a byte-for-byte copy of `build/icon.ico` (the existing Windows app icon: 16 to 256 px, generated from `build/icon-flat.svg`). Next serves it at `/favicon.ico` and adds the `<link rel="icon">` tag itself.
- `scripts/make-icons.mjs` also writes `app/favicon.ico` when it writes `build/icon.ico`, so the two never drift.

Done looks like: `GET /favicon.ico` answers 200 `image/x-icon` with those bytes on every page; no favicon console error.

Skill change: remove the temporary `favicon.ico` 404 entry from `budgets.json` `web.consoleErrors.known` (keep the `/api/stt/token` 503 entry) and drop the favicon mentions from the skill's known-errors text.

### 3. Accessibility

- 3a: the coverage ring button gets `aria-label="How much of this session isn't mapped yet"`, the same words its tooltip already shows. No visual change.
- 3b: contrast, Default theme. The user chose C1, and for C2 and C3 set the rule: the smallest change that reaches 4.5:1, preferring an existing theme color or gray. Ratios are WCAG contrast against the background axe measured.

| Fix | Element | Before | After | Change |
|---|---|---|---|---|
| C3 | Default theme `--muted-foreground` (`textMuted`), so every muted text in that theme, including the selected or hovered session row's meta line | #8d8d8d: 4.32:1 on #2a2a2a (row), 5.55:1 on #141414 | #919191: 4.55:1 on #2a2a2a, 5.85:1 on #141414, 5.41:1 on #1c1c1c | The smallest gray step that passes on the row's #2a2a2a surface. Changed in `app/globals.css` and `DEFAULT_THEME` in `src/core/themes.ts`, which a test keeps equal. `--ring` and `--lh-accent` stay #8d8d8d. Other themes keep their own `textMuted`. |
| C1 | Sidebar "Sessions" label, "Background agents" header | `text-muted-foreground/70`: #696969 on #141414, 3.35:1 | `text-muted-foreground`: #919191 on #141414, 5.85:1 | The user's choice (full muted). With C3 it renders #919191, not #8d8d8d. |
| C2 | Composer "Dictate" button, idle | `text-muted-foreground/70`: #6a6a6a on #181818, 3.28:1 | `text-muted-foreground/90`: #858585 on #181818, 4.81:1 | The smallest step of the existing token that passes. Hover stays `text-muted-foreground` (#919191, 5.63:1), so hover still brightens it. |

Done looks like: no `button-name` or `color-contrast` violation on the three pages the prove drive measures, in the Default theme.

### 4. Deleting the session you are viewing

- When the deleted session is the one on screen, the shell stops rendering that session's view immediately (the main pane is empty for the moment until home renders), then navigates home with `router.replace("/")` instead of `router.push("/")`, so Back does not lead to the deleted session. Unmounting the view clears its timers and listeners, so nothing fetches the deleted session. (T3 Code also replaces, not pushes, when it navigates away from a deleted thread: `apps/web/src/hooks/useThreadActions.ts`.)
- Deleting a session you are not viewing is unchanged.

Done looks like: opening a session, then right-click its row, Delete, confirm, logs no 404 for `/api/chats/<id>` or `/api/chats/<id>/side-chats` (repeat at least 10 times, including right after a turn starts), lands on home, and Back does not reopen the deleted session.

Skill change: the probe text in `SKILL.md` ("on main this can log a 404 ...") becomes "expect no 404 for the deleted session".

## Not changed

- Sidebar persistence key, default, width, animation timing, narrow-window rules.
- Other themes' colors and other `/70` muted text the prove drive does not reach (keyboard shortcuts dialog, settings): not flagged by the drive, left as is.
- The Electron shell's `.lh-electron` class and platform attribute still land after mount (a possible Electron-only shift); not in this PR.
- No CI files.
