/**
 * Keyboard focus through the sidebar's session list (issue #302), after T3
 * Code's sidebar (pingdotgg/t3code, MIT,
 * apps/web/src/components/sidebar/SidebarThreadRow.tsx at f9b19a7f): every row
 * is its own focus stop (a button with a visible focus ring), reached in
 * document order with Tab and Shift+Tab, opened with Enter or Space, and its
 * context menu opens from the keyboard (the Menu key or Shift+F10).
 *
 * LearnHarness has no native Tab (docs/keyboard.md: Tab cycles text fields,
 * Shift+Tab the thinking level; interaction-layers.tsx prevents the browser's
 * default), so the list moves focus itself, as the update pill's notes do
 * (sidebar-update-pill.tsx): Tab from the sessions search enters the first
 * row, Tab and Shift+Tab walk the rows, Shift+Tab on the first row returns to
 * the search, and Tab on the last row hands Tab back to the app. Keys the list
 * takes never reach the app's own Tab or Shift+Tab shortcuts.
 */

/** Marks a row the list's Tab walks: session rows and folder rows. */
export const SIDEBAR_STOP = "data-sidebar-stop";
export const sidebarStopProps = { [SIDEBAR_STOP]: "" } as const;

type Keyish = { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean };

/** The keys that open a context menu from the keyboard. */
export const isMenuKey = (event: Keyish): boolean =>
	!event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"));

/** The rows Tab can reach now, in document order: shown, enabled stops. */
export function sidebarStops(list: Element | null): HTMLElement[] {
	if (!list) return [];
	return Array.from(list.querySelectorAll<HTMLElement>(`[${SIDEBAR_STOP}]`)).filter((stop) =>
		!(stop as HTMLButtonElement).disabled && !stop.closest("[hidden], [aria-hidden='true']"));
}

type TabEvent = Keyish & { target: EventTarget | null; preventDefault(): void; stopPropagation(): void };

const plainTab = (event: Keyish) => event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey;

/** Tab in the sessions search: enter the first row. False when it isn't
 *  ours (no rows, Shift+Tab, a modifier), so the app's own Tab goes on. */
export function tabIntoList(event: TabEvent, list: Element | null): boolean {
	if (!plainTab(event) || event.shiftKey) return false;
	const first = sidebarStops(list)[0];
	if (!first) return false;
	event.preventDefault();
	event.stopPropagation();
	first.focus();
	return true;
}

/** Tab or Shift+Tab on a row: the next or previous row; Shift+Tab on the
 *  first row returns to the search. Tab on the last row is not ours. */
export function tabThroughList(event: TabEvent, list: Element | null, search: HTMLElement | null): boolean {
	if (!plainTab(event)) return false;
	const stops = sidebarStops(list);
	const at = stops.indexOf(event.target as HTMLElement);
	if (at < 0) return false; // a rename field or other control: its own keys
	const next = event.shiftKey ? (at > 0 ? stops[at - 1] : search) : stops[at + 1];
	if (!next) return false;
	event.preventDefault();
	event.stopPropagation();
	next.focus();
	return true;
}
