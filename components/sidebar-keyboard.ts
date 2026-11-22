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

type TabEvent = Keyish & { target: EventTarget | null; preventDefault(): void; stopPropagation(): void; nativeEvent?: { stopImmediatePropagation?(): void } };

/** Stop a key the list takes. Next.js hydrates the whole document, so
 *  React's root listener is on the document, and so are the question dock's
 *  keydown listener and others registered after it: stopPropagation alone
 *  only keeps the key from the window. stopImmediatePropagation on the native
 *  event also keeps it from those later document listeners. */
function stopHere(event: TabEvent): void {
	event.stopPropagation();
	event.nativeEvent?.stopImmediatePropagation?.();
}

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
	stopHere(event);
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
	stopHere(event);
	next.focus();
	return true;
}

const ROW_KEYS = new Set(["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/** Plain Enter, Space and arrows on a focused row are the row's: the button's
 *  native press opens it, and an open question dock's document listener
 *  (which submits on Enter and walks on the arrows) or the app's Enter never
 *  sees them. The default isn't prevented. Modified keys, Shift included, go
 *  on to the app's shortcuts. */
export function keepRowKeys(event: TabEvent): boolean {
	if (notOurs(event) || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !ROW_KEYS.has(event.key)) return false;
	const target = event.target as Element | null;
	if (!target?.hasAttribute?.(SIDEBAR_STOP)) return false;
	stopHere(event);
	return true;
}

/** Opened from a menu key: the browser may still send its own contextmenu
 *  after ours (Windows sends it on the Menu key's keyup), which would open
 *  the browser's menu over ours and ask for ours a second time. Cancel the
 *  next contextmenu once, in the document's capture phase (before React's
 *  root listener), until shortly after the key is let go (and never longer
 *  than a second), so a later right-click is untouched. A real right-button
 *  (or Ctrl+click) pointerdown ends the guard at once: the contextmenu after
 *  it is the pointer's. */
export function swallowNextContextMenu(target: EventTarget = document, { afterKeyUpMs = 100, maxMs = 1000 } = {}): void {
	let done = false;
	const stop = () => {
		if (done) return;
		done = true;
		target.removeEventListener("contextmenu", cancel, true);
		target.removeEventListener("keyup", onKeyUp, true);
		target.removeEventListener("pointerdown", onPointerDown, true);
		clearTimeout(cap);
	};
	const cancel = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); stop(); };
	const onKeyUp = (event: Event) => {
		const key = (event as KeyboardEvent).key;
		if (key === "ContextMenu" || key === "F10") setTimeout(stop, afterKeyUpMs);
	};
	const onPointerDown = (event: Event) => {
		const pointer = event as PointerEvent;
		if (pointer.button === 2 || pointer.ctrlKey) stop();
	};
	const cap = setTimeout(stop, maxMs);
	target.addEventListener("contextmenu", cancel, true);
	target.addEventListener("keyup", onKeyUp, true);
	target.addEventListener("pointerdown", onPointerDown, true);
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);
let lastInput: "keyboard" | "pointer" | null = null;

/** Remember whether the latest input was a key or a pointer, in the window's
 *  capture phase (before anything can stop it); returns the undo. A bare
 *  modifier doesn't count. */
export function trackInputModality(target: EventTarget = window): () => void {
	const onKey = (event: Event) => { if (!MODIFIER_KEYS.has((event as KeyboardEvent).key)) lastInput = "keyboard"; };
	const onPointer = () => { lastInput = "pointer"; };
	target.addEventListener("keydown", onKey, true);
	target.addEventListener("pointerdown", onPointer, true);
	return () => {
		target.removeEventListener("keydown", onKey, true);
		target.removeEventListener("pointerdown", onPointer, true);
	};
}

/** T3's final-focus rule: a menu or field gives focus back to its row only
 *  when it was opened from the keyboard or is closing from it. A pointer
 *  close leaves focus where the pointer put it, so a click on the transcript
 *  never leaves a row focused for the next Enter. */
export const fromKeyboard = (openedByKeyboard = false): boolean => openedByKeyboard || lastInput === "keyboard";

/** Close a row's context menu. When focus was in it and the menu was opened
 *  or is closing from the keyboard (fromKeyboard), focus goes back to the
 *  row, as T3's context menus give it back. MenuShell popups leave focus
 *  return to their owner (docs/dialog-overlay-contract.md). Focus that went
 *  somewhere real meanwhile stays: Rename's field, a new subfolder's field. */
export function closeMenuToRow(menuTestid: string, row: HTMLElement | null, close: () => void, openedByKeyboard = false): void {
	const menu = document.querySelector(`[data-testid="${menuTestid}"]`);
	const focusInMenu = !!menu && menu.contains(document.activeElement);
	close();
	if (!focusInMenu || !row || !fromKeyboard(openedByKeyboard)) return;
	setTimeout(() => {
		const now = document.activeElement;
		if ((!now || now === document.body || !now.isConnected) && row.isConnected) row.focus({ preventScroll: true });
	}, 0);
}

/** After a handoff ends (a rename committed or cancelled, a new subfolder's
 *  field left), focus the row `selector` names, unless focus already went
 *  somewhere real or the handoff neither began (`startedFromKeyboard`) nor
 *  ended from the keyboard. The row is found again because it may be a new
 *  element. */
export function focusWhenLost(selector: string, startedFromKeyboard = false): void {
	if (!fromKeyboard(startedFromKeyboard)) return;
	setTimeout(() => {
		const now = document.activeElement;
		if (now && now !== document.body && now.isConnected) return;
		document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
	}, 0);
}

const stopKey = (el: Element) => el.getAttribute("data-session-id") ?? el.getAttribute("data-testid") ?? "";
/** Focus that is somewhere real: not the page, not a removed element. */
const focusIsSomewhere = () => {
	const now = document.activeElement;
	return !!now && now !== document.body && now.isConnected;
};

/** The first stop still in `stops` after position `at` of `keys` (the list
 *  as it was), else the nearest before it. */
function nearestStop(stops: HTMLElement[], keys: string[], at: number): HTMLElement | undefined {
	const byKey = new Map(stops.map((stop) => [stopKey(stop), stop]));
	for (let i = at + 1; i < keys.length; i++) { const stop = byKey.get(keys[i]!); if (stop) return stop; }
	for (let i = at - 1; i >= 0; i--) { const stop = byKey.get(keys[i]!); if (stop) return stop; }
	return undefined;
}

/** A row the keyboard is deleting through a dialog (a session, or a folder
 *  with everything in it): `arm` it when the dialog opens, `cancel` when the
 *  dialog closes without deleting. On the first render without the row,
 *  if focus was lost with it (the dialog took it and is gone), the next row
 *  that is still there takes focus, else the previous one. Runs in the
 *  render's layout effect, so it never depends on timer order. */
export function createNeighborHandoff(getList: () => Element | null) {
	let pending: { key: string; keys: string[]; at: number } | null = null;
	return {
		arm(row: Element | null) {
			const stops = sidebarStops(getList());
			const at = row ? stops.indexOf(row as HTMLElement) : -1;
			pending = at < 0 ? null : { key: stopKey(row!), keys: stops.map(stopKey), at };
		},
		cancel() { pending = null; },
		/** Call after each render of the list. */
		afterRender() {
			if (!pending) return;
			const stops = sidebarStops(getList());
			if (stops.some((stop) => stopKey(stop) === pending!.key)) return; // not gone yet
			const { keys, at } = pending;
			pending = null;
			if (focusIsSomewhere()) return;
			nearestStop(stops, keys, at)?.focus({ preventScroll: true });
		},
	};
}

/** Keeps keyboard focus in the list when the list changes under it. A row
 *  the keyboard focused that disappears (a session deleted from another
 *  client) hands focus to the next row, else the previous one, else the
 *  search when it is shown. A focused row that moves (a re-sort when another
 *  session gets activity) keeps it. A row a click focused, and focus a
 *  pointer moved away, are left alone. Needs trackInputModality. */
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
				if (el?.hasAttribute?.(SIDEBAR_STOP) && list?.contains(el) && lastInput !== "pointer") {
					last = { key: stopKey(el), index: sidebarStops(list).indexOf(el) };
					pointerSinceFocus = false;
				} else last = null; // a click on a row, the search, a field, a menu
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
			const stops = sidebarStops(getList());
			if (focusIsSomewhere()) {
				// Still on the row (rows may have come or gone around it): keep
				// its place current, so a later removal hands focus to its real neighbour.
				const at = stops.indexOf(document.activeElement as HTMLElement);
				if (at >= 0 && stopKey(stops[at]!) === last.key) last.index = at;
				return;
			}
			if (pointerSinceFocus) { last = null; return; } // a click put focus on the page
			const same = stops.find((stop) => stopKey(stop) === last!.key);
			const shownSearch = search?.isConnected && !search.closest("[hidden], [aria-hidden='true'], [inert]") ? search : null;
			const next = same ?? stops[last.index] ?? stops[last.index - 1] ?? shownSearch;
			if (next) next.focus({ preventScroll: true });
			else last = null;
		},
	};
}
