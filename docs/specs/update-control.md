# Spec: update fixes and the sidebar update control

Status: decided by the owner, 2026-11-18. Base: main at bf262b7. Follows [t3-style-updates.md](t3-style-updates.md).
T3 Code reference: github.com/pingdotgg/t3code at 7e4c429 (MIT), `SidebarUpdateControl` in `apps/web/src/components/sidebar/SidebarUpdatePill.tsx`, `DesktopUpdateStatusIcon.tsx`, `desktopUpdate.logic.ts`.

## Bugs fixed

1. **Automatic checks never ran after an update.** A server started by an update runs as the launcher's trial, which skips the startup check, so the next automatic check was 4 hours away. Now the server checks 15 s after the launcher commits it (when "Check for updates automatically" is on). Not at once: the launcher deletes leftover `*.tmp` version folders right after a commit, which would delete a download being unpacked (found in the prove run); T3 also checks 15 s after launch. The interval stays 4 hours, like T3 (owner decision). The GitHub "Pre-release" flag is not involved: automatic and manual checks read the same `nightly/latest.json`, never `releases/latest`.
2. **The update icon stayed after Install until a reload.** Behind Tailscale Serve, the reconnect during the restart gets a 502, and EventSource then closes for good, so the page never heard anything again. The events channel now opens a new EventSource 3 s after one closes, and the open refetches as any reconnect does.
3. **The "Settings (⌘,)" hint stayed up after closing Settings.** The dialog hands focus back to the Settings button, and the tooltip opened on any focus. Tooltips now open on focus only when it is `:focus-visible` (keyboard), as the update pill already did.

## The sidebar update control

One round button (`size-8 rounded-full`, 16 px glyph) at the right end of the sidebar's Settings row, on the web and desktop apps (T3 hides it in the browser; here updates are server side). `resolveUpdateControl` picks the state, in T3's order:

| State | Icon | Tooltip | Click |
|---|---|---|---|
| reload (server newer than the page) | RotateCw with check badge | "Updated to X. Click to reload." | reload, confirming first when a message box (any typed-text box: the chat composer, the home topic box, answer fields) has unsent text: "You have an unsent message. Reload anyway?" (Cancel / Reload) |
| checking | RefreshCw, spinning, disabled | "Checking for updates…" | nothing |
| downloading | download arrow, no ring (no progress is measured), disabled | "Downloading update" | nothing |
| downloaded | RotateCw with check badge | "Update X downloaded. Click to restart and install." | the install confirm dialog |
| available (desktop) | download arrow with a dot | "Update X ready to download" | download |
| rolled-back notice | warning triangle | the notice text | dismiss |
| disabled | RefreshCw at 60% opacity, `aria-disabled` | "Updates unavailable" / "Automatic updates are not available in this build." | nothing |
| idle, up to date, check failed | RefreshCw | "Check for updates" | the same check as Settings > Check for updates |

The release notes popover opens on hover for downloaded and available when there are notes, as before.

Spin: a click latches the spin and remounts the icon so it starts from zero; it turns at least once and keeps turning while the state is `checking`, then stops at the next turn boundary. `motion-safe` only; paused while the tab is hidden.

Reload: GET /api/updates carries `runningVersion`; the page compares it with its own build version. It never reloads on its own.

Seam: "Update everything" (roadmap item 23 PR 2) adds its state in `resolveUpdateControl`. Not built here.
