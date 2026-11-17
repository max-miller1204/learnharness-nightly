/**
 * The sidebar's first-paint state (first-load polish, docs/specs/polish-first-load.md).
 *
 * The server can't read localStorage or the window width, so the root
 * layout inlines SIDEBAR_BOOT_SCRIPT in <head>: it runs while the HTML
 * parses, before the first paint, and sets data-lh-sidebar="closed" on
 * <html> when the sidebar should start closed. The sidebar's open/closed
 * look is driven by that attribute (the `sidebar-closed:` variant in
 * app/globals.css), so the server HTML is the same for everyone and the
 * first frame is already final: no slide-in, no layout shift. After mount
 * SidebarProvider keeps the attribute in sync with its state.
 *
 * A plain module (no "use client"), so the server layout gets the values.
 */

export const SIDEBAR_STORAGE_KEY = "lh:sidebar-open";

/** Below this window width the Electron shell auto-closes the sidebar
 *  (see the SIDEBAR_AUTOCLOSE note in components/sidebar.tsx).
 *  Mirrors SIDEBAR_AUTOCLOSE in electron/main.cjs: keep in sync. */
export const SIDEBAR_AUTOCLOSE = 928;

/** The <html> attribute the `sidebar-closed:` variant reads. */
export const SIDEBAR_CLOSED_ATTR = "data-lh-sidebar";

/** The stored preference: nothing stored = open (the default), "1" =
 *  open, anything else = closed. SidebarProvider and the boot script
 *  below apply this one rule. */
export function sidebarStoredOpen(stored: string | null): boolean {
	return stored === null || stored === "1";
}

/** Same rule as SidebarProvider: rendered = stored preference (default
 *  open) && !(Electron && narrow). Storage unavailable: open. */
export const SIDEBAR_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)});var n=navigator.userAgent.indexOf("Electron")!==-1&&window.innerWidth<${SIDEBAR_AUTOCLOSE};if((s!==null&&s!=="1")||n)document.documentElement.setAttribute(${JSON.stringify(SIDEBAR_CLOSED_ATTR)},"closed")}catch(e){}})()`;
