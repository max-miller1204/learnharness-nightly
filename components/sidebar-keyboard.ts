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
 * row (or the row the search's ↑/↓ walked to), Tab and Shift+Tab walk the
 * rows, Shift+Tab on the first row returns to the search, and Tab on the last
 * row hands Tab back to the app. The list's Tab and Shift+Tab, and plain
 * Enter, Space and arrows on a row, don't reach the app's shortcuts or an
 * open question dock. A Tab an open plugin question dock already claimed, or
 * one typed during IME composition, stays the dock's (keyboard-shortcuts.tsx
 * skips those too).
 */
import { composingQuestionKey, pluginQuestionKeySuppressed } from "./plugin-question-keys.ts";

/** Marks a row the list's Tab walks: session rows and folder rows. */
export const SIDEBAR_STOP = "data-sidebar-stop";
export const sidebarStopProps = { [SIDEBAR_STOP]: "" } as const;

type Keyish = { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean };
type Native = { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean; keyCode?: number } };

/** A key that already belongs to someone else: a plugin question dock
 *  claimed it in the capture phase, or an IME is composing. */
const notOurs = (event: object): boolean =>
	pluginQuestionKeySuppressed(event) || composingQuestionKey(event as Native);

/** The keys that open a context menu from the keyboard. */
export const isMenuKey = (event: Keyish): boolean =>
	!notOurs(event) && !event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"));

/** The rows Tab can reach now, in document order: shown, enabled stops. */
export function sidebarStops(list: Element | null): HTMLElement[] {
	if (!list) return [];
	return Array.from(list.querySelectorAll<HTMLElement>(`[${SIDEBAR_STOP}]`)).filter((stop) =>
		!(stop as HTMLButtonElement).disabled && !stop.closest("[hidden], [aria-hidden='true']"));
}

type TabEvent = Keyish & { target: EventTarget | null; preventDefault(): void; stopPropagation(): void };

const plainTab = (event: Keyish) => event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey;

/** Tab in the sessions search: enter the walked row if the search's ↑/↓
 *  walked to one, else the first row. False when it isn't ours (no rows,
 *  Shift+Tab, a modifier, a plugin dock's or an IME's key), so the app's own
 *  Tab goes on. */
export function tabIntoList(event: TabEvent, list: Element | null, walked: HTMLElement | null = null): boolean {
	if (notOurs(event) || !plainTab(event) || event.shiftKey) return false;
	const stops = sidebarStops(list);
	const next = walked && stops.includes(walked) ? walked : stops[0];
	if (!next) return false;
	event.preventDefault();
	event.stopPropagation();
	next.focus();
	return true;
}

/** Tab or Shift+Tab on a row: the next or previous row; Shift+Tab on the
 *  first row returns to the search. Tab on the last row is not ours. */
export function tabThroughList(event: TabEvent, list: Element | null, search: HTMLElement | null): boolean {
	if (notOurs(event) || !plainTab(event)) return false;
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

const ROW_KEYS = new Set(["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/** Plain Enter, Space and arrows on a focused row are the row's: the button's
 *  native press opens it, and an open question dock's document listener
 *  (which submits on Enter and walks on the arrows) or the app's Enter never
 *  sees them. The default isn't prevented. Modified keys go on to the app's
 *  shortcuts. */
export function keepRowKeys(event: TabEvent): boolean {
	if (notOurs(event) || event.altKey || event.ctrlKey || event.metaKey || !ROW_KEYS.has(event.key)) return false;
	const target = event.target as Element | null;
	if (!target?.hasAttribute?.(SIDEBAR_STOP)) return false;
	event.stopPropagation();
	return true;
}

/** Opened from a menu key: the browser may still send its own contextmenu
 *  after ours (Windows sends it on the Menu key's keyup), which would open
 *  the browser's menu over ours and ask for ours a second time. Cancel the
 *  next contextmenu once, in the document's capture phase (before React's
 *  root listener), until shortly after the key is let go (and never longer
 *  than a second), so a later right-click is untouched. */
export function swallowNextContextMenu(target: EventTarget = document, { afterKeyUpMs = 100, maxMs = 1000 } = {}): void {
	let done = false;
	const stop = () => {
		if (done) return;
		done = true;
		target.removeEventListener("contextmenu", cancel, true);
		target.removeEventListener("keyup", onKeyUp, true);
		clearTimeout(cap);
	};
	const cancel = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); stop(); };
	const onKeyUp = (event: Event) => {
		const key = (event as KeyboardEvent).key;
		if (key === "ContextMenu" || key === "F10") setTimeout(stop, afterKeyUpMs);
	};
	const cap = setTimeout(stop, maxMs);
	target.addEventListener("contextmenu", cancel, true);
	target.addEventListener("keyup", onKeyUp, true);
}

/** Close a row's context menu; when focus was in it (the keyboard was using
 *  it, or MenuShell had moved it there), focus goes back to the row, as T3's
 *  native context menus give it back. MenuShell popups leave focus return to
 *  their owner (docs/dialog-overlay-contract.md). Focus that went somewhere
 *  real meanwhile stays: a pointer on the search box, or Rename's field. */
export function closeMenuToRow(menuTestid: string, row: HTMLElement | null, close: () => void): void {
	const menu = document.querySelector(`[data-testid="${menuTestid}"]`);
	const focusInMenu = !!menu && menu.contains(document.activeElement);
	close();
	if (!focusInMenu || !row) return;
	setTimeout(() => {
		const now = document.activeElement;
		if ((!now || now === document.body || !now.isConnected) && row.isConnected) row.focus({ preventScroll: true });
	}, 0);
}

/** After a handoff ends (a rename committed or cancelled, a new subfolder's
 *  field left), focus the row `selector` names, unless focus already went
 *  somewhere real. The row is found again because it may be a new element. */
export function focusWhenLost(selector: string): void {
	setTimeout(() => {
		const now = document.activeElement;
		if (now && now !== document.body && now.isConnected) return;
		document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
	}, 0);
}

const stopKey = (el: Element) => el.getAttribute("data-session-id") ?? el.getAttribute("data-testid") ?? "";
const quoted = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

/** A selector that finds this row again after a re-render: a session row by
 *  its id, a folder row by its button's test id. */
export function rowSelector(row: Element): string {
	const id = row.getAttribute("data-session-id");
	return id !== null ? `[data-session-id=${quoted(id)}]` : `button[data-testid=${quoted(row.getAttribute("data-testid") ?? "")}]`;
}

/** The row is about to go (its session deleted): once it has, and if focus
 *  was lost with it, focus the next row, else the previous one. */
export function focusNeighborWhenLost(list: Element | null, row: Element | null): void {
	const stops = sidebarStops(list);
	const at = row ? stops.indexOf(row as HTMLElement) : -1;
	if (at < 0) return;
	const next = stops[at + 1] ?? stops[at - 1];
	if (next) focusWhenLost(rowSelector(next));
}

/** Keeps keyboard focus in the list when the list changes under it. A
 *  focused row that disappears (a session deleted from another client)
 *  hands focus to the next row, else the previous one, else the search. A
 *  focused row that moves (a re-sort when another session gets activity)
 *  keeps it. A pointer that moved focus away is left alone. */
export function createRowFocusKeeper(getList: () => Element | null) {
	// The row that has focus now; null once focus is anywhere else.
	let last: { key: string; index: number } | null = null;
	let pointerSinceFocus = false;
	return {
		/** Listen for focus and pointers on the document; returns the undo. */
		attach(doc: Document = document): () => void {
			const onFocusIn = (event: Event) => {
				const el = event.target as HTMLElement | null;
				const list = getList();
				if (el?.hasAttribute?.(SIDEBAR_STOP) && list?.contains(el)) {
					last = { key: stopKey(el), index: sidebarStops(list).indexOf(el) };
					pointerSinceFocus = false;
				} else last = null; // the search, a field, a menu: not a row
			};
			const onPointerDown = () => { pointerSinceFocus = true; };
			doc.addEventListener("focusin", onFocusIn, true);
			doc.addEventListener("pointerdown", onPointerDown, true);
			return () => {
				doc.removeEventListener("focusin", onFocusIn, true);
				doc.removeEventListener("pointerdown", onPointerDown, true);
			};
		},
		/** Call after each render of the list. */
		afterRender(search: HTMLElement | null) {
			if (!last) return;
			const now = document.activeElement;
			if (now && now !== document.body && now.isConnected) return;
			if (pointerSinceFocus) { last = null; return; } // a click put focus on the page
			const stops = sidebarStops(getList());
			const same = stops.find((stop) => stopKey(stop) === last!.key);
			const next = same ?? stops[last.index] ?? stops[last.index - 1] ?? search;
			if (next) next.focus({ preventScroll: true });
			else last = null;
		},
	};
}
