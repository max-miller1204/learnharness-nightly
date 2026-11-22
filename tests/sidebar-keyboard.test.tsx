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
import { isMenuKey, sidebarStops, tabIntoList, tabThroughList } from "../components/sidebar-keyboard.ts";
import type { ChatListItem } from "../src/core/contracts.ts";

const dom = parseHTML("<html><body></body></html>");
let focused: Element | undefined;
dom.window.HTMLElement.prototype.focus = function () { focused = this; };
Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => (focused?.isConnected ? focused : dom.document.body) });
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const chat = (id: string, title: string): ChatListItem => ({ id, title, createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z", busy: false } as unknown as ChatListItem);
const folder = { id: "f1", name: "Physics", parentId: null, createdAt: "2026-10-01T00:00:00.000Z" };

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const opened: string[] = [];
const menus: string[] = [];

/** The sidebar's list as sidebar.tsx wires it: the search's Tab enters the
 *  rows, the rows container walks them (see the source check below). */
function List({ hiddenRow = false }: { hiddenRow?: boolean }) {
	const search = React.useRef<HTMLInputElement>(null);
	const list = React.useRef<HTMLDivElement>(null);
	return (
		<div>
			<input ref={search} data-testid="session-search" onKeyDown={(e) => { tabIntoList(e, list.current); }} />
			<div ref={list} data-testid="session-rows" onKeyDown={(e) => { tabThroughList(e, e.currentTarget, search.current); }}>
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

async function mount(props: { hiddenRow?: boolean } = {}) {
	focused = undefined; opened.length = 0; menus.length = 0;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(<List {...props} />); });
}
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; host?.remove(); });

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-session-id="${id}"]`)!;
const focusedName = () => (focused as HTMLElement | undefined)?.getAttribute("data-session-id") ?? (focused as HTMLElement | undefined)?.getAttribute("data-testid") ?? null;

let reachedWindow = 0;
dom.window.addEventListener("keydown", () => { reachedWindow++; });
async function press(target: Element, key: string, mods: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) {
	const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperties(event, { key: { value: key }, shiftKey: { value: !!mods.shiftKey }, altKey: { value: !!mods.altKey }, ctrlKey: { value: !!mods.ctrlKey }, metaKey: { value: !!mods.metaKey } });
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
		assert.deepEqual(menus, ["c1", "c2", "folder"], "each opened once (the native contextmenu event is prevented)");
		assert.equal(await press(rowOf("c1"), "F10"), false, "plain F10 is not the menu key");
		assert.equal(await press(rowOf("c1"), "ContextMenu", { ctrlKey: true }), false);
		assert.deepEqual(menus, ["c1", "c2", "folder"]);
		assert.equal(isMenuKey({ key: "F10", shiftKey: true, altKey: false, ctrlKey: false, metaKey: false }), true);
	});

	it("sidebar.tsx wires the same handlers into the real list and search", () => {
		const source = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
		assert.match(source, /data-testid="session-rows" onKeyDown=\{\(e\) => \{ tabThroughList\(e, e\.currentTarget, searchRef\.current\); \}\}/);
		assert.match(source, /if \(tabIntoList\(e, listRef\.current\)\) return;/);
		const search = source.slice(source.indexOf('data-testid="session-search"'));
		assert.ok(search.indexOf("tabIntoList") < search.indexOf('e.key === "Escape"'), "the search's Tab is handled first");
	});
});
