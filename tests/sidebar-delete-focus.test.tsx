/**
 * #358 round 2: a session deleted from the keyboard through the real Delete
 * dialog hands focus to its neighbour, whatever order the dialog's focus
 * return and the list's re-render run in. The list is wired as sidebar.tsx
 * wires it: the row is focused before the dialog opens (so it is the
 * dialog's opener), the neighbour hand-off is armed then, cancelled when the
 * dialog closes without deleting, and both it and the focus keeper run in
 * the list's layout effect.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { DeleteSessionDialog } from "../components/delete-session-dialog.tsx";
import { SessionRow } from "../components/sidebar.tsx";
import { createNeighborHandoff, createRowFocusKeeper, releaseRowAfterPointerClose, trackInputModality } from "../components/sidebar-keyboard.ts";
import type { ChatListItem } from "../src/core/contracts.ts";
import { installModalDom } from "./modal-dom.ts";

let root: Root | undefined, restore: (() => void) | undefined;
const originalFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => root?.unmount()); root = undefined;
	await new Promise((resolve) => setTimeout(resolve, 5));
	restore?.(); restore = undefined; globalThis.fetch = originalFetch;
});

const chat = (id: string): ChatListItem => ({ id, title: id, createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z", busy: false } as unknown as ChatListItem);
let startDelete!: (id: string) => void;

function Sidebarish() {
	const [ids, setIds] = React.useState(["a", "b", "c"]);
	const [deleting, setDeleting] = React.useState<ChatListItem | null>(null);
	const search = React.useRef<HTMLInputElement>(null);
	const getRows = () => document.querySelector('[data-testid="session-rows"]');
	const [keeper] = React.useState(() => createRowFocusKeeper(getRows));
	const [handoff] = React.useState(() => createNeighborHandoff(getRows));
	React.useEffect(() => trackInputModality(document), []);
	React.useEffect(() => keeper.attach(document), [keeper]);
	React.useLayoutEffect(() => { handoff.afterRender(); keeper.afterRender(search.current); });
	const opener = React.useRef<HTMLElement | null>(null);
	// The session menu's Delete… (sidebar.tsx): the row is the dialog's opener.
	startDelete = (id) => {
		const row = document.querySelector<HTMLElement>(`[data-session-id="${id}"]`)!;
		row.focus({ preventScroll: true });
		handoff.arm(row);
		opener.current = row;
		setDeleting(chat(id));
	};
	return (
		<div>
			<input ref={search} data-testid="session-search" />
			<div data-testid="session-rows">
				{ids.map((id) => <SessionRow key={id} chat={chat(id)} active={false} onOpen={() => {}} onContextMenu={() => {}} />)}
			</div>
			<DeleteSessionDialog
				chat={deleting}
				onClose={() => { handoff.cancel(); releaseRowAfterPointerClose(opener.current); setDeleting(null); }}
				onDeleted={(id) => { releaseRowAfterPointerClose(opener.current); setDeleting(null); setIds((previous) => previous.filter((other) => other !== id)); }}
			/>
		</div>
	);
}

async function mount() {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const globals = { React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModalDom = installModalDom(dom);
	// A browser's blur(): focus leaves for the page (the modal fixture has focus() only).
	const prototype = dom.window.HTMLElement.prototype;
	const originalBlur = prototype.blur;
	prototype.blur = function () { if (dom.document.activeElement === this) (dom.document.body as unknown as HTMLElement).focus(); };
	restore = () => {
		prototype.blur = originalBlur;
		restoreModalDom();
		for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
	};
	root = createRoot(document.querySelector("#root")!);
	await act(async () => root!.render(<InteractionLayersProvider><Sidebarish /></InteractionLayersProvider>));
	// The keyboard is in use (the Menu key, then Enter on Delete…).
	document.body.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true }), { key: "Enter" }));
}
const byTest = (id: string) => { const node = document.querySelector<HTMLElement>(`[data-testid='${id}']`); assert(node, `missing ${id}`); return node; };
const focusedName = () => {
	const el = document.activeElement as HTMLElement | null;
	return el && el !== document.body && el.isConnected ? el.getAttribute("data-session-id") ?? el.getAttribute("data-testid") : null;
};
/** A pointer press on `node`, then its click. */
const pointerClick = (node: HTMLElement) => act(async () => {
	node.dispatchEvent(Object.assign(new window.Event("pointerdown", { bubbles: true }), { button: 0 }));
	node.click();
});
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 2)); });

it("a confirmed Delete from the keyboard gives focus to the next row", async () => {
	globalThis.fetch = (async () => Response.json({ ok: true, graphRevision: 1 })) as typeof fetch;
	await mount();
	await act(async () => startDelete("b"));
	await settle();
	assert.ok(document.querySelector('[data-testid="delete-session-dialog"]'), "the dialog is open");
	assert.notEqual(focusedName(), "b", "the dialog took focus");
	await act(async () => byTest("delete-confirm").click());
	await settle();
	assert.equal(document.querySelector('[data-testid="delete-session-dialog"]'), null, "the dialog closed");
	assert.equal(document.querySelector('[data-session-id="b"]'), null, "the row went");
	assert.equal(focusedName(), "c");
	// The last row: the previous one.
	await act(async () => startDelete("c"));
	await settle();
	await act(async () => byTest("delete-confirm").click());
	await settle();
	assert.equal(focusedName(), "a");
});

it("a Delete cancelled from the keyboard, or refused and then cancelled, gives focus back to its row", async () => {
	globalThis.fetch = (async () => Response.json({ ok: false, code: "turn_running", error: "A turn is running in this session" }, { status: 409 })) as typeof fetch;
	await mount();
	await act(async () => startDelete("b"));
	await settle();
	await act(async () => byTest("delete-confirm").click());
	await settle();
	assert.ok(document.querySelector('[data-testid="delete-session-dialog"]'), "refused: the dialog stays open");
	await act(async () => byTest("delete-cancel").click());
	await settle();
	assert.equal(document.querySelector('[data-testid="delete-session-dialog"]'), null);
	assert.equal(focusedName(), "b", "the dialog's opener, the row, has focus again");
	await act(async () => byTest("session-search").focus());
	assert.equal(focusedName(), "session-search");
});

it("a Delete dialog closed with the pointer leaves focus where the pointer put it, not on the row (#358 prove)", async () => {
	globalThis.fetch = (async () => Response.json({ ok: true, graphRevision: 1 })) as typeof fetch;
	await mount();
	await act(async () => startDelete("b"));
	await settle();
	await pointerClick(byTest("delete-cancel"));
	await settle();
	assert.equal(document.querySelector('[data-testid="delete-session-dialog"]'), null);
	assert.equal(focusedName(), null, "Cancel clicked: the row doesn't take focus");
	await act(async () => startDelete("b"));
	await settle();
	await pointerClick(byTest("delete-confirm"));
	await settle();
	assert.equal(document.querySelector('[data-session-id="b"]'), null, "deleted");
	assert.equal(focusedName(), null, "confirmed with the pointer: no neighbour takes focus");
});
