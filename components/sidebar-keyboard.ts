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
 * row enters the footer. The list's Tab and Shift+Tab, and plain
 * Enter, Space and arrows on a row, don't reach the app's shortcuts or an
 * open question dock. A Tab an open plugin question dock already claimed, or
 * one typed during IME composition, stays the dock's (keyboard-shortcuts.tsx
 * skips those too).
 */
import { composingQuestionKey, pluginQuestionKeySuppressed } from "./plugin-question-keys.ts";
import { buttonKeepsNativeEnter } from "./enter-submits";

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
const PRESS_KEYS = new Set(["Enter", " "]);
const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/** Tab in the sessions search enters the walked row, the first row, or the
 *  footer when no rows are shown. Modified and claimed keys stay with the app. */
export function tabIntoList(event: TabEvent, list: Element | null, walked: HTMLElement | null = null, footer: Element | null = null): boolean {
	if (notOurs(event) || !plainTab(event) || event.shiftKey) return false;
	const stops = sidebarStops(list);
	const next = (walked && stops.includes(walked) ? walked : stops[0]) ?? footerStops(footer)[0];
	if (!next) return false;
	event.preventDefault();
	stopHere(event);
	next.focus();
	return true;
}

/** Tab or Shift+Tab on a row: the next or previous row; Shift+Tab on the
 *  first row returns to the search. Tab on the last row enters the footer. */
export function tabThroughList(event: TabEvent, list: Element | null, search: HTMLElement | null, footer: HTMLElement | null = null): boolean {
	if (notOurs(event) || !plainTab(event)) return false;
	const stops = sidebarStops(list);
	const at = stops.indexOf(event.target as HTMLElement);
	if (at < 0) return false; // a rename field or other control: its own keys
	const next = event.shiftKey ? (at > 0 ? stops[at - 1] : search) : stops[at + 1] ?? footer;
	if (!next) return false;
	event.preventDefault();
	stopHere(event);
	next.focus();
	return true;
}

/** Footer order follows T3: Settings, then update.
 * https://github.com/pingdotgg/t3code/blob/df09ced7688dec80a9c66c80181144cfb50f62ce/apps/web/src/components/sidebar/SidebarChrome.tsx#L270-L311 */
export function footerStops(footer: Element | null): HTMLElement[] {
	if (!footer) return [];
	return Array.from(footer.querySelectorAll<HTMLElement>('[data-testid="settings-entry"], [data-testid="update-pill"], [data-testid="update-capsule-button"], [data-testid="update-capsule-action"]'))
		.filter((el) => !el.closest('[hidden], [aria-hidden="true"], [inert]') && !(el as HTMLButtonElement).disabled && (typeof el.checkVisibility !== 'function' || el.checkVisibility()));
}

export function tabThroughFooter(event: TabEvent, footer: Element, list: Element | null, search: HTMLElement | null = null): boolean {
	if (notOurs(event) || !plainTab(event)) return false;
	const stops = footerStops(footer);
	const at = stops.indexOf(event.target as HTMLElement);
	if (at < 0) return false;
	const next = event.shiftKey ? (at ? stops[at - 1] : sidebarStops(list).at(-1) ?? search) : stops[at + 1];
	if (!next) return false;
	event.preventDefault();
	stopHere(event);
	next.focus();
	return true;
}

/** Footer buttons retain native activation and do not submit a question. */
export function keepFooterKeys(event: TabEvent): void {
	if (notOurs(event) || event.altKey || event.ctrlKey || event.metaKey) return;
	const target = event.target as HTMLElement | null;
	if (!target || !buttonKeepsNativeEnter(target)) return;
	if (PRESS_KEYS.has(event.key) || (!event.shiftKey && ARROW_KEYS.has(event.key))) stopHere(event);
}

/** Enter and Space (with or without Shift) and plain arrows on a focused row
 *  are the row's: the button's native press opens it, and an open question
 *  dock's document listener (which submits on Enter or Shift+Enter and walks
 *  on the arrows) or the app's Enter never sees them. The default isn't
 *  prevented. Ctrl, Alt and Meta chords, and Shift+arrows, go on to the
 *  app's shortcuts. */
export function keepRowKeys(event: TabEvent): boolean {
	if (notOurs(event) || event.altKey || event.ctrlKey || event.metaKey) return false;
	if (!PRESS_KEYS.has(event.key) && (event.shiftKey || !ARROW_KEYS.has(event.key))) return false;
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

/** T3's final-focus rule (finalFocus by close type): a menu, field or dialog
 *  gives focus back to its row only when it closes from the keyboard. A
 *  pointer close leaves focus where the pointer put it, whatever opened it,
 *  so a click on the transcript never leaves a row focused for the next
 *  Enter. */
export const closedFromKeyboard = (): boolean => lastInput === "keyboard";

/** Restore keyboard focus when an update control is replaced or hidden. */
export function watchFooterFocus(footer: HTMLElement, doc: Document = document): () => void {
	let last: HTMLElement | null = null;
	const onFocus = (event: Event) => {
		const target = event.target as HTMLElement;
		last = footer.contains(target) && lastInput !== "pointer" ? target : null;
	};
	const onPointer = () => { last = null; };
	const onKey = (event: Event) => {
		const key = event as KeyboardEvent;
		const target = key.target as HTMLElement | null;
		if (!MODIFIER_KEYS.has(key.key) && target && footer.contains(target)) last = target;
	};
	const reconcile = () => {
		if (!last || lastInput === "pointer" || footer.closest('[inert], [aria-hidden="true"]')) return;
		const active = doc.activeElement;
		if (active && active !== doc.body && active !== last && active.isConnected) { last = null; return; }
		if (footerStops(footer).includes(last)) return;
		const stops = footerStops(footer);
		const replacement = stops.find((el) => el.matches('[data-testid="update-pill"], [data-testid="update-capsule-button"]')) ?? stops[0];
		last = null;
		replacement?.focus({ preventScroll: true });
	};
	const observer = new MutationObserver(reconcile);
	observer.observe(footer, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "aria-hidden", "style"] });
	const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reconcile);
	resize?.observe(footer);
	doc.addEventListener("focusin", onFocus, true);
	doc.addEventListener("pointerdown", onPointer, true);
	doc.addEventListener("keydown", onKey, true);
	window.addEventListener("resize", reconcile);
	return () => { observer.disconnect(); resize?.disconnect(); doc.removeEventListener("focusin", onFocus, true); doc.removeEventListener("pointerdown", onPointer, true); doc.removeEventListener("keydown", onKey, true); window.removeEventListener("resize", reconcile); };
}

/** A dialog whose opener is `row` (it gives focus back to its opener) has
 *  closed. A pointer close leaves focus where the pointer put it: when the
 *  dialog's focus return lands on the row, the row lets it go. That return
 *  is the next focus to arrive; any key or pointer first, or a second
 *  passing, ends the watch. */
export function releaseRowAfterPointerClose(row: HTMLElement | null, doc: Document = document): void {
	if (!row || closedFromKeyboard()) return;
	const onFocus = (event: Event) => {
		end();
		if (event.target === row) row.blur();
	};
	const end = () => {
		clearTimeout(cap);
		doc.removeEventListener("focusin", onFocus, true);
		doc.removeEventListener("keydown", end, true);
		doc.removeEventListener("pointerdown", end, true);
	};
	const cap = setTimeout(end, 1000);
	doc.addEventListener("focusin", onFocus, true);
	doc.addEventListener("keydown", end, true);
	doc.addEventListener("pointerdown", end, true);
}

/** Close a row's context menu. When focus was in it and it is closing from
 *  the keyboard (closedFromKeyboard), focus goes back to the row, as T3's
 *  context menus give it back. MenuShell popups leave focus return to their
 *  owner (docs/dialog-overlay-contract.md). Focus that went somewhere real
 *  meanwhile stays: Rename's field, a new subfolder's field. */
export function closeMenuToRow(menuTestid: string, row: HTMLElement | null, close: () => void): void {
	const menu = document.querySelector(`[data-testid="${menuTestid}"]`);
	const focusInMenu = !!menu && menu.contains(document.activeElement);
	close();
	if (!focusInMenu || !row || !closedFromKeyboard()) return;
	setTimeout(() => {
		const now = document.activeElement;
		if ((!now || now === document.body || !now.isConnected) && row.isConnected) row.focus({ preventScroll: true });
	}, 0);
}

/** After a handoff ends from the keyboard (a rename committed or cancelled,
 *  a new subfolder's field left), focus the row `selector` names, unless
 *  focus already went somewhere real. Ended by a pointer, focus stays where
 *  the pointer put it. The row is found again because it may be a new
 *  element. */
export function focusWhenLost(selector: string): void {
	if (!closedFromKeyboard()) return;
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

/** A row being deleted through a dialog (a session, or a folder with
 *  everything in it): `arm` it when the dialog opens, `cancel` when the
 *  dialog closes without deleting. On the first render without the row, if
 *  the delete was confirmed from the keyboard and focus was lost with the
 *  row, the next row that is still there takes focus, else the previous one.
 *  Runs in the render's layout effect, so it never depends on timer order. */
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
			if (focusIsSomewhere() || !closedFromKeyboard()) return;
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
