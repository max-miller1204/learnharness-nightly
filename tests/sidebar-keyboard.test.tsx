/**
 * Issue #302: the sidebar's session rows are reachable from the keyboard, as
 * in T3 Code's sidebar (every row a focus stop with a visible ring, Enter
 * opens it, the Menu key or Shift+F10 opens its context menu). LearnHarness
 * has no native Tab, so the list moves focus itself: Tab from the search into
 * the rows, Tab and Shift+Tab through them, back to the search, and Tab past
 * the last row goes on to the app's own Tab.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { SessionRow } from "../components/sidebar.tsx";
import { SidebarFolderRow } from "../components/sidebar-folders.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { MenuShell } from "../components/menu-shell.tsx";
import { capturePluginQuestionKey, ownPluginQuestionKeys } from "../components/plugin-question-keys.ts";
import { closeMenuToRow, createRowFocusKeeper, isMenuKey, keepRowKeys, sidebarStops, swallowNextContextMenu, tabIntoList, tabThroughList } from "../components/sidebar-keyboard.ts";
import type { ChatListItem } from "../src/core/contracts.ts";

const dom = parseHTML("<html><body></body></html>");
let focused: Element | undefined;
// A browser's focus(): the element becomes active and focusin bubbles from it.
dom.window.HTMLElement.prototype.focus = function () {
	focused = this;
	this.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
};
Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => (focused?.isConnected ? focused : dom.document.body) });
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
	HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLButtonElement: dom.window.HTMLButtonElement,
	// What MenuShell and the interaction layers use (as tests/modal-dom.ts provides them).
	Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	getSelection: () => ({ anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0 }),
	IS_REACT_ACT_ENVIRONMENT: true,
});
if (!dom.window.HTMLElement.prototype.getBoundingClientRect) dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON() {} }) as DOMRect;

const chat = (id: string, title: string): ChatListItem => ({ id, title, createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z", busy: false } as unknown as ChatListItem);
const folder = { id: "f1", name: "Physics", parentId: null, createdAt: "2026-10-01T00:00:00.000Z" };

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const opened: string[] = [];
const menus: string[] = [];

/** The sidebar's list as sidebar.tsx wires it: the search's Tab enters the
 *  rows (or the walked one), the rows container walks them and keeps the
 *  rows' own keys (see the source check below). */
function List({ hiddenRow = false, walked = null as string | null }) {
	const search = React.useRef<HTMLInputElement>(null);
	const list = React.useRef<HTMLDivElement>(null);
	return (
		<div>
			<input ref={search} data-testid="session-search" onKeyDown={(e) => {
				const walkedRow = walked ? list.current?.querySelector<HTMLElement>(`[data-session-id="${walked}"]`) ?? null : null;
				tabIntoList(e, list.current, walkedRow);
			}} />
			<div ref={list} data-testid="session-rows" onKeyDown={(e) => { if (!tabThroughList(e, e.currentTarget, search.current)) keepRowKeys(e); }}>
				<SidebarFolderRow folder={folder} depth={0} open dropActive={false} renaming={false} draggable={false}
					onToggle={() => opened.push("folder")} onContextMenu={() => menus.push("folder")} onRename={async () => {}} onRenameDone={() => {}} />
				<SessionRow chat={chat("c1", "Kinematics")} depth={1} active={false} onOpen={() => opened.push("c1")} onContextMenu={() => menus.push("c1")} />
				<input data-testid="rename-field" />
				<div aria-hidden={hiddenRow ? "true" : undefined}>
					<SessionRow chat={chat("c2", "Optics")} active onOpen={() => opened.push("c2")} onContextMenu={() => menus.push("c2")} />
				</div>
			</div>
		</div>
	);
}

async function render(node: React.ReactNode) {
	focused = undefined; opened.length = 0; menus.length = 0;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(node); });
}
const mount = (props: { hiddenRow?: boolean; walked?: string | null } = {}) => render(<List {...props} />);
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; host?.remove(); ownPluginQuestionKeys(null as never)(); });

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-session-id="${id}"]`)!;
// What really has focus: a removed element counts as the page (body).
const focusedName = () => {
	const el = document.activeElement as HTMLElement | null;
	return el && el !== document.body ? el.getAttribute("data-session-id") ?? el.getAttribute("data-testid") : null;
};
const tick = (ms = 5) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

let reachedWindow = 0;
dom.window.addEventListener("keydown", () => { reachedWindow++; });
type Mods = { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean };
function keyEvent(type: string, key: string, mods: Mods = {}) {
	const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, { key: { value: key }, shiftKey: { value: !!mods.shiftKey }, altKey: { value: !!mods.altKey }, ctrlKey: { value: !!mods.ctrlKey }, metaKey: { value: !!mods.metaKey }, isComposing: { value: !!mods.isComposing } });
	return event;
}
async function press(target: Element, key: string, mods: Mods = {}) {
	const event = keyEvent("keydown", key, mods);
	await act(async () => { target.dispatchEvent(event); });
	return event.defaultPrevented;
}

describe("session rows from the keyboard", () => {
	it("every row is a focus stop with a visible focus ring (T3's row classes)", async () => {
		await mount();
		for (const el of [byId("sidebar-folder-f1"), rowOf("c1"), rowOf("c2")]) {
			assert.equal(el.tagName, "BUTTON");
			assert.equal(el.hasAttribute("data-sidebar-stop"), true);
			assert.notEqual(el.getAttribute("tabindex"), "-1");
			assert.match(el.className, /\bfocus-visible:ring-2\b/);
			assert.match(el.className, /\bfocus-visible:ring-ring\b/);
		}
		assert.deepEqual(sidebarStops(byId("session-rows")).map((el) => el.getAttribute("data-session-id") ?? el.getAttribute("data-testid")), ["sidebar-folder-f1", "c1", "c2"]);
	});

	it("Tab enters the rows from the search, walks them in order, and Shift+Tab walks back to the search", async () => {
		await mount();
		reachedWindow = 0;
		assert.equal(await press(byId("session-search"), "Tab"), true);
		assert.equal(focusedName(), "sidebar-folder-f1", "the first row, a folder");
		assert.equal(await press(byId("sidebar-folder-f1"), "Tab"), true);
		assert.equal(focusedName(), "c1");
		assert.equal(await press(rowOf("c1"), "Tab"), true);
		assert.equal(focusedName(), "c2", "the rename field between them is not a stop");
		assert.equal(await press(rowOf("c2"), "Tab", { shiftKey: true }), true);
		assert.equal(focusedName(), "c1");
		await press(rowOf("c1"), "Tab", { shiftKey: true });
		await press(byId("sidebar-folder-f1"), "Tab", { shiftKey: true });
		assert.equal(focusedName(), "session-search", "Shift+Tab on the first row returns to the search");
		assert.equal(reachedWindow, 0, "the app's Tab (fields) and Shift+Tab (thinking level) never saw these");
	});

	it("Tab from the search enters the row the ↑/↓ walk is on (#358 review)", async () => {
		await mount({ walked: "c2" });
		assert.equal(await press(byId("session-search"), "Tab"), true);
		assert.equal(focusedName(), "c2");
	});

	it("leaves the keys that aren't the list's to the app", async () => {
		await mount();
		reachedWindow = 0;
		focused = rowOf("c2");
		assert.equal(await press(rowOf("c2"), "Tab"), false, "Tab past the last row is the app's own Tab");
		assert.equal(await press(byId("session-search"), "Tab", { shiftKey: true }), false, "Shift+Tab in the search stays the thinking-level shortcut");
		assert.equal(await press(rowOf("c1"), "Tab", { ctrlKey: true }), false, "modified Tab is not ours");
		assert.equal(await press(byId("rename-field"), "Tab"), false, "a field in the list keeps its own Tab");
		assert.equal(reachedWindow, 4);
	});

	it("a Tab an open plugin question dock claimed, or one typed during IME composition, stays theirs (#358 review)", async () => {
		await mount();
		// The dock's capture listener, as interaction-layers.tsx runs it on the
		// window before the target (linkedom has no capture order, so the test
		// runs it first itself).
		const cycled: string[] = [];
		ownPluginQuestionKeys({ eligible: () => true, contains: () => false, key: () => "pass", submit: () => {}, cycle: (key) => { cycled.push(key); } });
		const claimedTab = async (target: Element) => {
			const event = keyEvent("keydown", "Tab");
			capturePluginQuestionKey(event as unknown as KeyboardEvent);
			await act(async () => { target.dispatchEvent(event); });
		};
		focused = byId("session-search");
		await claimedTab(byId("session-search"));
		assert.deepEqual(cycled, ["Tab"], "the dock took it");
		assert.equal(focusedName(), "session-search", "the sidebar didn't also move focus");
		focused = rowOf("c1");
		await claimedTab(rowOf("c1"));
		assert.equal(focusedName(), "c1");
		ownPluginQuestionKeys(null as never)();
		focused = byId("session-search");
		await press(byId("session-search"), "Tab", { isComposing: true });
		assert.equal(focusedName(), "session-search", "IME composition: not ours");
		await press(byId("session-search"), "Tab");
		assert.equal(focusedName(), "sidebar-folder-f1", "a plain Tab with no dock still enters the rows");
	});

	it("plain Enter, Space and arrows on a row never reach an open question dock's document listener (#358 review)", async () => {
		await mount();
		// The built-in quiz dock listens on the document in the bubble phase (question-dock.tsx).
		const dock: string[] = [];
		const onDock = (e: Event) => { dock.push((e as KeyboardEvent).key); };
		dom.document.addEventListener("keydown", onDock);
		try {
			for (const key of ["Enter", " ", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"]) {
				assert.equal(await press(rowOf("c1"), key), false, `${JSON.stringify(key)} keeps the button's native default`);
			}
			assert.deepEqual(dock, [], "the dock saw none of the row's keys, so a quiz can't be submitted from a row");
			await press(rowOf("c1"), "b", { metaKey: true });
			await press(byId("rename-field"), "Enter");
			await press(byId("session-search"), "ArrowDown");
			assert.deepEqual(dock, ["b", "Enter", "ArrowDown"], "modified keys and keys from fields still go on");
		} finally {
			dom.document.removeEventListener("keydown", onDock);
		}
	});

	it("skips rows that aren't shown", async () => {
		await mount({ hiddenRow: true });
		focused = rowOf("c1");
		assert.equal(await press(rowOf("c1"), "Tab"), false, "c2 is hidden: c1 is the last stop");
		assert.deepEqual(sidebarStops(byId("session-rows")).length, 2);
	});

	it("Enter keeps the button's native press; the Menu key and Shift+F10 open the row's context menu", async () => {
		await mount();
		assert.equal(await press(rowOf("c1"), "Enter"), false, "not prevented: the native button press opens the session");
		await act(async () => { rowOf("c1").dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		assert.deepEqual(opened, ["c1"]);
		assert.equal(await press(rowOf("c1"), "ContextMenu"), true);
		assert.equal(await press(rowOf("c2"), "F10", { shiftKey: true }), true);
		assert.equal(await press(byId("sidebar-folder-f1"), "ContextMenu"), true);
		assert.deepEqual(menus, ["c1", "c2", "folder"]);
		assert.equal(await press(rowOf("c1"), "F10"), false, "plain F10 is not the menu key");
		assert.equal(await press(rowOf("c1"), "ContextMenu", { ctrlKey: true }), false);
		assert.deepEqual(menus, ["c1", "c2", "folder"]);
		assert.equal(isMenuKey({ key: "F10", shiftKey: true, altKey: false, ctrlKey: false, metaKey: false }), true);
	});

	it("the browser's own contextmenu after a menu key (Windows sends it on keyup) is cancelled once; a later right-click works (#358 review)", async () => {
		await tick(1100); // guards from the earlier menu-key presses end on their own
		await mount();
		const contextmenu = async (target: Element) => {
			const event = new dom.window.Event("contextmenu", { bubbles: true, cancelable: true });
			await act(async () => { target.dispatchEvent(event); });
			return event.defaultPrevented;
		};
		await press(rowOf("c1"), "ContextMenu");
		assert.deepEqual(menus, ["c1"]);
		await act(async () => { rowOf("c1").dispatchEvent(keyEvent("keyup", "ContextMenu")); });
		// (That ours isn't asked again needs the browser's capture order: the
		// Chrome drive checks it. linkedom runs the document listener last.)
		assert.equal(await contextmenu(rowOf("c1")), true, "the browser's menu after the key is cancelled");
		assert.equal(await contextmenu(rowOf("c1")), false, "only once");
		await tick(150);
		const before = menus.length;
		assert.equal(await contextmenu(rowOf("c1")), false, "a right-click afterwards isn't touched");
		assert.equal(menus.length, before + 1, "and opens the menu as usual");
		// No contextmenu ever comes (Linux, macOS): the guard ends on its own.
		swallowNextContextMenu(dom.document as unknown as EventTarget, { maxMs: 20 });
		await tick(40);
		assert.equal(await contextmenu(rowOf("c2")), false);
	});

	it("a menu the keyboard was using gives focus back to its row when it closes; a pointer's new focus stays", async () => {
		await mount();
		const menuFor = () => {
			const menu = document.createElement("div");
			menu.setAttribute("data-testid", "session-context-menu");
			const item = document.createElement("button");
			menu.appendChild(item);
			document.body.appendChild(menu);
			return { menu, item };
		};
		// Esc with focus in the menu: the menu unmounts, focus returns to the row.
		let { menu, item } = menuFor();
		focused = item;
		closeMenuToRow("session-context-menu", rowOf("c1"), () => { menu.remove(); focused = undefined; });
		await tick();
		assert.equal(focusedName(), "c1");
		// A click elsewhere moved focus first: it stays there.
		({ menu, item } = menuFor());
		focused = byId("session-search");
		closeMenuToRow("session-context-menu", rowOf("c1"), () => menu.remove());
		await tick();
		assert.equal(focusedName(), "session-search");
		// Focus in the menu, but the close put it somewhere real: not taken back.
		({ menu, item } = menuFor());
		focused = item;
		closeMenuToRow("session-context-menu", rowOf("c1"), () => { menu.remove(); focused = byId("rename-field"); });
		await tick();
		assert.equal(focusedName(), "rename-field", "Rename's own field keeps focus");
	});
});

/** A real MenuShell closed the ways the sidebar's menus close: an item, Esc
 *  and a click away, each through closeMenuToRow as sidebar.tsx does. */
function MenuHarness() {
	const anchor = React.useRef<HTMLButtonElement>(null);
	const [open, setOpen] = React.useState(false);
	const close = () => closeMenuToRow("test-menu", anchor.current, () => setOpen(false));
	React.useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: Event) => {
			const target = e.target as Element;
			if (target.closest?.("[data-lh-menu]") || anchor.current?.contains(target)) return;
			close();
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	});
	return (
		<div>
			<input data-testid="search" />
			<p data-testid="blank">text</p>
			<button ref={anchor} data-testid="row" onClick={() => setOpen(true)}>row</button>
			{open && (
				<MenuShell anchorRef={anchor} testid="test-menu" preferredSide="down" menuClass="menu" onClose={() => { close(); return "closed"; }}>
					<button type="button" data-testid="item" onClick={() => close()}>Export</button>
				</MenuShell>
			)}
		</div>
	);
}

describe("a real MenuShell gives focus back to its row however it closes (#358 review)", () => {
	const openMenu = async () => {
		await act(async () => { byId("row").dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		await tick();
		assert.ok(document.querySelector('[data-testid="test-menu"]'), "the menu is open");
		byId("item").focus(); // the keyboard is in the menu
	};
	const closed = () => document.querySelector('[data-testid="test-menu"]') === null;

	it("choosing an item", async () => {
		await render(<InteractionLayersProvider><MenuHarness /></InteractionLayersProvider>);
		await openMenu();
		await act(async () => { byId("item").dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		await tick();
		assert.equal(closed(), true);
		assert.equal(focusedName(), "row");
	});

	it("Esc", async () => {
		await render(<InteractionLayersProvider><MenuHarness /></InteractionLayersProvider>);
		await openMenu();
		await press(byId("item"), "Escape");
		await tick();
		assert.equal(closed(), true);
		assert.equal(focusedName(), "row");
	});

	it("a click away on blank space returns focus to the row; one on the search box keeps it there", async () => {
		await render(<InteractionLayersProvider><MenuHarness /></InteractionLayersProvider>);
		await openMenu();
		await act(async () => { byId("blank").dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); });
		await tick();
		assert.equal(closed(), true);
		assert.equal(focusedName(), "row", "blank space takes no focus: back to the row");
		await openMenu();
		await act(async () => { byId("search").dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); byId("search").focus(); });
		await tick();
		assert.equal(closed(), true);
		assert.equal(focusedName(), "search", "the pointer focused the search box: it keeps focus");
	});
});

/** Rows as a live list: `ids` changes as the server's list does. */
function LiveList({ ids }: { ids: string[] }) {
	const search = React.useRef<HTMLInputElement>(null);
	const list = React.useRef<HTMLDivElement>(null);
	const [keeper] = React.useState(() => createRowFocusKeeper(() => list.current));
	React.useEffect(() => keeper.attach(dom.document as unknown as Document), [keeper]);
	React.useLayoutEffect(() => { keeper.afterRender(search.current); });
	return (
		<div>
			<input ref={search} data-testid="session-search" />
			<div ref={list} data-testid="session-rows">
				{ids.map((id) => <SessionRow key={id} chat={chat(id, id)} active={false} onOpen={() => {}} />)}
			</div>
		</div>
	);
}

describe("focus survives the list changing under it (#358 review)", () => {
	const show = (ids: string[]) => act(async () => { root!.render(<LiveList ids={ids} />); });

	it("a focused row that disappears hands focus to the next row, else the previous one, else the search", async () => {
		await render(<LiveList ids={["a", "b", "c"]} />);
		rowOf("b").focus();
		await show(["a", "c"]); // b deleted from another client
		assert.equal(focusedName(), "c", "the next row");
		await show(["a"]);
		assert.equal(focusedName(), "a", "c was last: the previous row");
		await show([]);
		assert.equal(focusedName(), "session-search", "no rows left: the search");
	});

	it("a focused row that moves keeps focus; a pointer that moved focus away is left alone", async () => {
		await render(<LiveList ids={["a", "b", "c"]} />);
		rowOf("c").focus();
		focused = undefined; // a browser blurs the moved node
		await show(["c", "a", "b"]); // c got activity and moved to the top
		assert.equal(focusedName(), "c");
		await act(async () => { dom.document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); });
		focused = undefined; // the click landed on blank space
		await show(["c", "b", "a"]);
		assert.equal(focusedName(), null, "not pulled back after a click");
		byId("session-search").focus();
		focused = undefined; // Esc in the search leaves it
		await show(["a", "b", "c"]);
		assert.equal(focusedName(), null, "focus last on the search: no row takes it");
	});
});

describe("sidebar.tsx wiring", () => {
	it("uses the same handlers in the real list, search and menus", () => {
		const source = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
		assert.match(source, /data-testid="session-rows" onKeyDown=\{\(e\) => \{ if \(!tabThroughList\(e, e\.currentTarget, searchRef\.current\)\) keepRowKeys\(e\); \}\}/);
		assert.match(source, /if \(tabIntoList\(e, listRef\.current, walked\)\) \{ setKbdIndex\(null\); return; \}/);
		const search = source.slice(source.indexOf('data-testid="session-search"'));
		assert.ok(search.indexOf("tabIntoList") < search.indexOf('e.key === "Escape"'), "the search's Tab is handled first");
		// Every close of either menu goes through closeMenuToRow.
		const outsideHelper = (text: string) => text.replace(/closeMenuToRow\([^;]*?\(\) => set\w+\(null\)\)/g, "");
		const sessionMenu = source.slice(source.indexOf("{ctxChatId !== null && ("), source.indexOf("{ctxFolderId !== null && ("));
		assert.doesNotMatch(outsideHelper(sessionMenu), /setCtxChatId\(null\)/, "no session-menu item closes it directly");
		const folderMenu = source.slice(source.indexOf("{ctxFolderId !== null && ("), source.indexOf("<DeleteSessionDialog"));
		assert.doesNotMatch(outsideHelper(folderMenu), /setCtxFolderId\(null\)/, "no folder-menu item closes it directly");
		const deleteFolder = source.slice(source.indexOf("const deleteFolder = "), source.indexOf("const copy = folderDeleteCopy("));
		assert.doesNotMatch(deleteFolder, /setCtxFolderId\(null\)/, "the folder Delete closes through the helper too");
		assert.equal((source.match(/closeMenuToRow\("session-context-menu", ctxAnchorRef\.current, /g) ?? []).length, 3, "Esc (onClose), click-away, and closeSessionMenu for the items");
		assert.equal((source.match(/closeMenuToRow\("folder-context-menu", folderAnchorRef\.current, /g) ?? []).length, 3);
		assert.match(source, /returnFocusFallback=\{deleteReturn \?\? undefined\}/);
		assert.match(source, /returnFocusFallback=\{folderDeleteReturn \?\? undefined\}/);
		assert.match(source, /focusKeeper\.afterRender\(searchRef\.current\)/);
		assert.match(source, /swallowNextContextMenu\(\);/);
	});
});
