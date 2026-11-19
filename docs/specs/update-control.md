# Spec: update fixes and the sidebar update control

Status: decided by the owner, 2026-11-18. Base: main at bf262b7. Follows [t3-style-updates.md](t3-style-updates.md).
T3 Code reference: github.com/pingdotgg/t3code at 7e4c429 (MIT), `SidebarUpdateControl` in `apps/web/src/components/sidebar/SidebarUpdatePill.tsx`, `DesktopUpdateStatusIcon.tsx`, `desktopUpdate.logic.ts`.

## Bugs fixed

1. **Automatic checks never ran after an update.** A server started by an update runs as the launcher's trial, which skips the startup check, so the next automatic check was 4 hours away. Now the server checks 15 s after the launcher commits it (when "Check for updates automatically" is on). Not at once: the launcher deletes leftover `*.tmp` version folders right after a commit, which would delete a download being unpacked (found in the prove run); T3 also checks 15 s after launch. The interval stays 4 hours, like T3 (owner decision). The GitHub "Pre-release" flag is not involved: automatic and manual checks read the same `nightly/latest.json`, never `releases/latest`.
2. **The update icon stayed after Install until a reload.** Behind Tailscale Serve, the reconnect during the restart gets a 502, and EventSource then closes for good, so the page never heard anything again. The events channel now opens a new EventSource when one closes: after 1 s, doubling per failed try up to 5 min (T3's connection supervisor), never while the tab is hidden, and at once when it shows again. The open refetches as any reconnect does.
3. **The "Settings (⌘,)" hint stayed up after closing Settings.** The dialog hands focus back to the Settings button, and the tooltip opened on any focus. Tooltips now open on focus only when it is `:focus-visible` (keyboard), as the update pill already did.

## The sidebar update control

One round button (`size-8 rounded-full`, 16 px glyph) at the right end of the sidebar's Settings row, on the web and desktop apps (T3 hides it in the browser; here updates are server side). `resolveUpdateControl` picks the state, in T3's order:

| State | Icon | Tooltip | Click |
|---|---|---|---|
| reload (server version differs from the page's) | RotateCw with check badge | server newer: "Updated to X. Click to reload." (shown only until the page reloads by itself, see Reload below); server older (after a rollback): "Server is on X. Click to reload." | reload, confirming first when any editable text field on the page has unsent text: "You have an unsent message. Reload anyway?" (Cancel / Reload) |
| checking | RefreshCw, spinning, disabled | "Checking for updates…" | nothing |
| downloading | download arrow, no ring (no progress is measured), disabled | "Downloading update" | nothing |
| downloaded | RotateCw with check badge | "Update X downloaded. Click to restart and install." | the install confirm dialog |
| available (desktop) | download arrow with a dot | "Update X ready to download" | download |
| rolled-back notice | warning triangle | the notice text | dismiss |
| disabled | RefreshCw at 60% opacity, `aria-disabled` | "Updates unavailable" / "Automatic updates are not available in this build." | nothing |
| idle, up to date, check failed | RefreshCw | "Check for updates" | the same check as Settings > Check for updates |

The release notes popover opens on hover for downloaded and available when there are notes, as before.

Spin: a click latches the spin and remounts the icon so it starts from zero; it turns at least once and keeps turning while the state is `checking`, then stops at the next turn boundary. `motion-safe` only; paused while the tab is hidden (an inline `animation-play-state`, so the class's `animation` shorthand can't undo it).

Reload: GET /api/updates carries `runningVersion`; the page compares it with its own build version and offers a reload whenever they differ (owner decision).

Automatic reload (owner decision, 2026-11-18, replaces "it never reloads on its own"): once the server is back and runs a newer version than the page's code, every open page reloads by itself: the window where "Install and restart" was clicked and every other tab or window, in a browser or a desktop app window on a remote server (the local desktop app restarts as a whole). Unsent text does not stop it and there is no confirm. It happens at most once per server version per tab: the tab remembers every version it reloaded for (the last 50) in sessionStorage, so a page whose code still doesn't match after the reload (a stale cache) keeps the button instead of looping, also when the server goes back and forth between versions (found by the proof: remembering only the last version let a stale tab reload for .73, .74, then .73 again); without usable sessionStorage the page never reloads by itself and keeps the button. After a rollback (server older than the page) the page does not reload by itself; the button waits for a click. The button's click stays as the fallback, with its unsent text confirm. "Back" means the trial server answers: an update first runs as the launcher's trial, so a page can reload onto a trial that then fails its health check and rolls back; that page then shows "Server is on X. Click to reload." (no loop).

Unsent text: any non-empty, user-editable text field (PathInput boxes, textareas such as the side-question box and the comment editor, text inputs), skipping read-only, disabled and hidden fields and search, find or filter boxes.

GET /api/health stays public (the launcher calls it without a credential) and keeps `runningVersion` and the update state, but update error text (`message` while `status` is "error", the reason in a rollback notice) only goes to a signed-in or paired caller; others still see `status: "error"` and a generic rollback notice (owner decision). `lh status` asks with its CLI session, so it still shows the details. Health's `idle` is false whenever an update check or download is in flight, whatever the state shows (a ready version stays "downloaded" while a newer one is fetched; found by the independent proof), so a launcher relaunch (which waits for idle) can't stop the server mid-download. The other work that blocks idle is unchanged: chat turns, compactions, background jobs, plugin workers and extractions.

What's new waits for the reload (owner decision): while the server runs a newer version than the page's code, the "What's new" popup is held back (not shown, not marked seen), so the reload button stays visible until the page reloads by itself. It shows once on the first page that runs the new version, after the automatic reload (or a click on the button, or the next time the app opens). GET /api/whats-new already answers the running version, so the page compares that with its own build version.

Seam: "Update everything" (roadmap item 23 PR 2) adds its state in `resolveUpdateControl`. Not built here.
