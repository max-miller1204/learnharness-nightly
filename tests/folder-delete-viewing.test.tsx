/**
 * The folder Delete keeps the session Delete's "delete while viewing" rules
 * (docs/specs/polish-first-load.md, item 4): every session in the folder
 * holds its view's reads while the request is in flight, and an open session
 * that went is dropped at once and left with a replace, so Back never reopens
 * a session that no longer exists.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { installModalDom } from "./modal-dom.ts";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { DeleteFolderDialog, folderDeleteCopy } from "../components/delete-session-dialog.tsx";
import { leaveDeletedSession, sessionReadHold } from "../components/session-deletion.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent });
const restoreModalDom = installModalDom(dom);
after(() => restoreModalDom());
const originalFetch = globalThis.fetch;
const roots: Root[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
	document.body.innerHTML = "";
	globalThis.fetch = originalFetch;
});

const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
/** What a held read of `id` does within a moment: "now" (no hold), "ran" (released) or "held". */
async function readOf(id: string): Promise<"now" | "ran" | "held"> {
	const hold = sessionReadHold(id);
	if (!hold) return "now";
	return Promise.race([hold.then(() => "ran" as const), new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 30))]);
}

async function openDialog(chatIds: string[], answer: Promise<Response>, partly: string[][] = []) {
	const calls: Array<{ deletedChatIds: string[] }> = [];
	globalThis.fetch = (async () => answer) as typeof fetch;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	const folder = {
		id: "physics", name: "Physics",
		copy: folderDeleteCopy({ sessions: chatIds.length, subfolders: 0, notes: 0, parentName: null }),
		scope: { parentId: null, folderIds: ["physics"], chatIds, noteIds: [] },
	};
	await act(async () => {
		root.render(<InteractionLayersProvider><DeleteFolderDialog folder={folder} onClose={() => {}} onStale={() => {}} onDeleted={(result) => calls.push(result)} onPartlyDeleted={(ids) => partly.push(ids)} /></InteractionLayersProvider>);
	});
	const confirm = document.querySelector<HTMLElement>("[data-testid='delete-confirm']");
	assert.ok(confirm, "the folder dialog's Delete");
	await act(async () => { confirm.click(); });
	return calls;
}

describe("the folder Delete while a session in it is open", () => {
	it("holds every session's reads during the request, and keeps a deleted one's held", async () => {
		let answer!: (response: Response) => void;
		const calls = await openDialog(["chat_folder_a", "chat_folder_b"], new Promise<Response>((resolve) => { answer = resolve; }));
		assert.equal(await readOf("chat_folder_a"), "held", "in flight: the open view's reads wait");
		assert.equal(await readOf("chat_folder_b"), "held");
		answer(Response.json({ deletedChatIds: ["chat_folder_a", "chat_folder_b"], graphRevision: 3 }));
		await tick();
		assert.deepEqual(calls, [{ deletedChatIds: ["chat_folder_a", "chat_folder_b"], graphRevision: 3 }]);
		assert.equal(await readOf("chat_folder_a"), "held", "deleted: its reads never run (the view unmounts)");
	});

	it("a refused folder Delete lets the reads run", async () => {
		const calls = await openDialog(["chat_folder_c"], Promise.resolve(Response.json({ error: "Busy", code: "turn_running" }, { status: 409 })));
		await tick();
		assert.deepEqual(calls, []);
		assert.equal(await readOf("chat_folder_c"), "now", "nothing deleted, nothing held");
	});

	it("a Delete that failed partway keeps the removed sessions' reads held and reports them; the rest run", async () => {
		const partly: string[][] = [];
		const calls = await openDialog(["chat_folder_gone", "chat_folder_left"], Promise.resolve(Response.json({ error: "Could not finish", code: "error", deletedChatIds: ["chat_folder_gone"] }, { status: 500 })), partly);
		await tick();
		assert.deepEqual(calls, []);
		assert.deepEqual(partly, [["chat_folder_gone"]], "the sidebar hears which went, to leave the open one");
		assert.equal(await readOf("chat_folder_gone"), "held", "removed: its reads never run");
		assert.equal(await readOf("chat_folder_left"), "now", "still there: its reads run");
	});

	it("leaves an open session that went with a replace, after dropping its view, and refreshes the router cache", () => {
		const log: string[] = [];
		const drop = (id: string) => log.push(`drop ${id}`);
		const replace = (href: string) => log.push(`replace ${href}`);
		const refresh = () => log.push("refresh");
		leaveDeletedSession("/chat/chat_open", ["chat_other", "chat_open"], drop, replace, refresh);
		assert.deepEqual(log, ["drop chat_open", "replace /", "refresh"], "dropped first, then replaced, then router refreshed");
		log.length = 0;
		leaveDeletedSession("/chat/chat_open", ["chat_other"], drop, replace, refresh);
		assert.deepEqual(log, ["refresh"], "deleting a non-open session still refreshes the router cache without leaving");
		log.length = 0;
		leaveDeletedSession("/graph", ["chat_open"], drop, replace, refresh);
		assert.deepEqual(log, ["refresh"], "deleting from another page refreshes the router cache without leaving");
		log.length = 0;
		leaveDeletedSession("/chat/chat_open", [], drop, replace, refresh);
		assert.deepEqual(log, [], "empty delete list does nothing");
	});
});
