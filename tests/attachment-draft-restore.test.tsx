/**
 * Issue #367: an attachment attached but not sent comes back when the learner
 * leaves the session and returns (Back), like the text draft (#347). T3
 * keeps the finished upload's id with the draft (composerDraftStore.ts) and
 * drops one the server no longer has. Here: a finished upload is restored
 * and sendable, an upload still running when the learner leaves is cancelled
 * and released (never duplicated or half restored), an upload the server
 * dropped goes quietly, and stored state reads tolerantly.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import { DraftAttachmentChips, restoreTimeouts, useAttachmentDraft, type AttachmentDraft } from "../components/attachment-draft.tsx";
import { beginSessionDelete } from "../components/session-deletion.ts";
import { ATTACHMENT_DRAFT_KEY_PREFIX, dropStoredAttachments, forgetStoredAttachments, readStoredAttachments, storeAttachment } from "../lib/attachment-drafts.ts";

const values = new Map<string, string>();
/** Most characters the fake storage holds. */
let quota = Infinity;
const storage = {
	get length() { return values.size; },
	key: (i: number) => [...values.keys()][i] ?? null,
	getItem: (key: string) => values.get(key) ?? null,
	setItem: (key: string, value: string) => {
		if ([...values].reduce((sum, [name, text]) => sum + (name === key ? 0 : text.length), value.length) > quota) throw new Error("QuotaExceededError");
		values.set(key, value);
	},
	removeItem: (key: string) => { values.delete(key); },
};
const keyOf = (id: string) => ATTACHMENT_DRAFT_KEY_PREFIX + id;
const stored = (id: string) => values.has(keyOf(id)) ? (JSON.parse(values.get(keyOf(id))!) as { rows: { id: string; name: string }[] }).rows : [];

interface Call { method: string; url: string; keepalive?: boolean }

/** What a real fetch does: a request waiting on `held` ends when its signal aborts. */
const heldUntilAborted = (held: Promise<void> | null, signal?: AbortSignal | null) => held === null ? Promise.resolve() : new Promise<void>((resolve, reject) => {
	void held.then(resolve);
	const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
	if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort);
});
let calls: Call[] = [];
/** The status the server answers for a stored upload's id (404 when absent). */
let statusOf: Map<string, number>;
/** Uploads started and not yet finished or aborted. */
let transfers: Scripted[] = [];
let capabilities: string[] = [];
let grants = 0;
let statusFailure = false;
/** While set, the server's answer to a status check waits for it. */
let holdStatus: Promise<void> | null = null;
/** Status checks for these ids wait for their promise. */
let holdIds = new Map<string, Promise<void>>();
/** While set, the server-info answer waits for it; infoFailure makes it fail. */
let holdInfo: Promise<void> | null = null;
let infoFailure = false;
/** The status the server-info route answers. */
let infoStatus = 200;
/** Answers to the next DELETEs, in order (204 after they run out). */
let deleteAnswers: number[] = [];
let statusSignals: (AbortSignal | undefined)[] = [];

class Scripted {
	upload = {} as { onprogress?: unknown };
	status = 204;
	responseText = "";
	url = "";
	onload?: () => void;
	onerror?: () => void;
	onabort?: () => void;
	aborted = false;
	open(_method: string, url: string) { this.url = url; }
	send() { transfers.push(this); }
	abort() { this.aborted = true; transfers = transfers.filter(item => item !== this); this.onabort?.(); }
	finish() { transfers = transfers.filter(item => item !== this); this.onload?.(); }
}

let cleanup: (() => Promise<void>) | undefined;
let latest!: AttachmentDraft;
let render!: (id: string) => Promise<void>;
let doc!: Document;
const saved: Record<string, PropertyDescriptor | undefined> = {};

beforeEach(async () => {
	values.clear(); calls = []; transfers = []; statusOf = new Map(); grants = 0; statusFailure = false; holdStatus = null; holdIds = new Map(); holdInfo = null; infoFailure = false; infoStatus = 200; restoreTimeouts.info = 5000; restoreTimeouts.check = 5000; deleteAnswers = []; statusSignals = []; quota = Infinity;
	capabilities = ["attachment-uploads-v1", "attachment-status-v1"];
	const { window: win, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	doc = document;
	Object.defineProperty(win, "localStorage", { configurable: true, value: storage });
	const originals: Record<string, unknown> = {
		window: win, document, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element, Event: win.Event, CustomEvent: win.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true, XMLHttpRequest: Scripted,
		fetch: async (input: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const url = String(input);
			calls.push({ method, url, keepalive: init?.keepalive });
			if (url === "/.well-known/learnharness/server") {
				await heldUntilAborted(holdInfo, init?.signal);
				if (infoFailure) throw new TypeError("offline");
				return infoStatus === 200 ? Response.json({ capabilities }) : new Response("unavailable", { status: infoStatus });
			}
			if (method === "POST" && url === "/api/attachments") {
				const id = randomUUID();
				statusOf.set(id, 204);
				grants++;
				return Response.json({ id, uploadUrl: `/upload/${id}`, expiresAt: Date.now() + 600_000 }, { status: 201 });
			}
			if (method === "DELETE") {
				const answer = deleteAnswers.shift() ?? 204;
				if (answer === 204) statusOf.delete(url.split("/").pop()!);
				return new Response(null, { status: answer });
			}
			if (method === "GET" && url.startsWith("/api/attachments/")) {
				statusSignals.push(init?.signal ?? undefined);
				const id = decodeURIComponent(url.slice("/api/attachments/".length).split("?")[0]!);
				await heldUntilAborted(holdStatus, init?.signal);
				await heldUntilAborted(holdIds.get(id) ?? null, init?.signal);
				if (statusFailure) throw new TypeError("offline");
				return new Response(null, { status: statusOf.get(id) ?? 404 });
			}
			assert.fail(`Unexpected fixture request: ${method} ${url}`);
		},
	};
	for (const [name, value] of Object.entries({ React, ...originals })) {
		saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	function Session({ id }: { id: string }) {
		const draft = useAttachmentDraft(id);
		latest = draft;
		return <DraftAttachmentChips draft={draft} />;
	}
	// Each visit remounts the session's composer, as app/chat/[id]/page.tsx keys Chat by session.
	render = async id => { await act(async () => { root.render(<Session key={id} id={id} />); }); await settle(); };
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of Object.entries(saved)) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name];
		}
	};
});
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 1)); });
const pdf = (name = "notes.pdf") => new File(["synthetic"], name, { type: "application/pdf" });
const chips = () => [...doc.querySelectorAll("[data-attachment-upload] span.truncate")].map(element => element.textContent);
const attach = async (...files: File[]) => { await act(async () => { latest.select(files); }); await settle(); };
const finishUploads = async () => { for (const transfer of [...transfers]) await act(async () => { transfer.finish(); }); await settle(); };

describe("an unsent attachment survives leaving the session and pressing Back (#367)", () => {
	it("restores a finished upload, per session, and it is sendable", async () => {
		await render("a");
		await attach(pdf());
		await finishUploads();
		assert.deepEqual(chips(), ["notes.pdf"]);
		const [id] = latest.files.map(row => row.grant!.id);
		assert.deepEqual(stored("a").map(row => row.id), [id], "saved with the draft once it finished");

		await render("b");
		assert.deepEqual(chips(), [], "B never shows A's attachment");
		await render("a"); // Back
		assert.deepEqual(chips(), ["notes.pdf"]);
		assert.equal(grants, 1, "restored, not uploaded again");
		assert.ok(calls.some(call => call.method === "GET" && call.url === `/api/attachments/${id}?chatId=a`), "the server was asked");
		const send = await latest.prepare("hello");
		assert.deepEqual(send?.attachmentUploadIds, [id]);

		// Sending clears it, as the text draft is.
		await act(async () => { latest.accept(send!); });
		assert.deepEqual(chips(), []);
		assert.deepEqual(stored("a"), []);
		await render("b");
		await render("a");
		assert.deepEqual(chips(), [], "a sent attachment never comes back");
	});

	it("restores a folder with its file count and counts it against the limits", async () => {
		const id = randomUUID();
		const files = Array.from({ length: 3 }, (_, index) => ({ path: `f${index}.md`, mimeType: "text/markdown", size: 10 }));
		storeAttachment("a", { id, name: "Notes", at: Date.now(), files });
		statusOf.set(id, 204);
		await render("a");
		assert.deepEqual(chips(), ["Notes · 3 files"]);
		assert.deepEqual((await latest.prepare("x"))?.attachmentUploadIds, [id]);
		// 3 restored files + 98 more is over the message's 100.
		await attach(...Array.from({ length: 98 }, (_, index) => pdf(`extra${index}.pdf`)));
		assert.match(latest.validation ?? "", /100/);
		assert.equal(latest.files.length, 1);
	});

	it("an upload still running when the learner leaves is cancelled and released, never restored or duplicated", async () => {
		await render("a");
		await attach(pdf("done.pdf"));
		await finishUploads();
		await attach(pdf("running.pdf"));
		assert.equal(transfers.length, 1, "running.pdf is mid-upload");
		const running = latest.files.find(row => row.name === "running.pdf")!;
		const runningId = running.grant!.id;
		await render("b");
		assert.equal(transfers.length, 0, "its transfer was aborted");
		assert.ok(calls.some(call => call.method === "DELETE" && call.url === `/api/attachments/${runningId}`), "its reservation was released");
		assert.deepEqual(stored("a").map(row => row.name), ["done.pdf"], "only the finished one is kept");
		const before = grants;
		await render("a");
		assert.deepEqual(chips(), ["done.pdf"]);
		assert.equal(grants, before, "nothing uploads again");
		assert.equal(transfers.length, 0);
		// The learner can send what is there, with exactly the finished upload.
		assert.equal((await latest.prepare("go"))?.attachmentUploadIds.length, 1);
	});

	it("an upload that finishes only after the learner left is not kept", async () => {
		await render("a");
		await attach(pdf());
		const transfer = transfers[0]!;
		await render("b");
		await act(async () => { transfer.finish(); }); // a late completion of the aborted transfer
		await settle();
		assert.deepEqual(stored("a"), []);
		await render("a");
		assert.deepEqual(chips(), []);
	});

	it("an upload the server no longer has drops out quietly, and a send waiting on it stops", async () => {
		await render("a");
		await attach(pdf("gone.pdf"), pdf("kept.pdf"));
		await finishUploads();
		const [gone, kept] = latest.files.map(row => row.grant!.id);
		await render("b");
		statusOf.delete(gone!); // expired or swept meanwhile
		await render("a");
		assert.deepEqual(chips(), ["kept.pdf"]);
		assert.equal(latest.validation, undefined, "no error is shown");
		assert.deepEqual(stored("a").map(row => row.id), [kept], "and it is forgotten");
		assert.deepEqual((await latest.prepare("x"))?.attachmentUploadIds, [kept]);
	});

	it("Send pressed while the check is in flight waits, and stops if the upload turned out to be gone", async () => {
		const id = randomUUID();
		storeAttachment("a", { id, name: "gone.pdf", at: Date.now(), mimeType: "application/pdf", size: 9 });
		let release!: () => void;
		holdStatus = new Promise(resolve => { release = resolve; });
		await render("a");
		assert.deepEqual(chips(), ["gone.pdf"], "shown at once");
		const outcome: string[] = [];
		const pending = latest.prepare("x", () => outcome.push("unavailable")).then(result => outcome.push(String(result)));
		await settle();
		assert.deepEqual(outcome, [], "still waiting for the server");
		release(); // the server has no such upload: 404
		await act(async () => { await pending; });
		assert.deepEqual(outcome, ["unavailable", "null"], "the send stopped; it never went without the file");
		assert.deepEqual(chips(), []);
	});

	it("keeps the chip when the check can't be made; the send is the judge", async () => {
		const id = randomUUID();
		storeAttachment("a", { id, name: "notes.pdf", at: Date.now(), mimeType: "application/pdf", size: 9 });
		statusFailure = true;
		await render("a");
		assert.deepEqual(chips(), ["notes.pdf"]);
		assert.deepEqual(stored("a").map(row => row.id), [id]);
	});

	it("restores nothing from a server without the status check", async () => {
		const id = randomUUID();
		storeAttachment("a", { id, name: "notes.pdf", at: Date.now(), mimeType: "application/pdf", size: 9 });
		capabilities = ["attachment-uploads-v1"];
		await render("a");
		assert.deepEqual(chips(), []);
		assert.equal(calls.filter(call => call.url.startsWith("/api/attachments/")).length, 0);
		assert.deepEqual(stored("a").map(row => row.id), [id], "left for a server that can check");
	});

	it("Remove forgets the stored attachment and releases it", async () => {
		await render("a");
		await attach(pdf());
		await finishUploads();
		const id = latest.files[0]!.grant!.id;
		await act(async () => { latest.remove(latest.files[0]!); });
		await settle();
		assert.deepEqual(stored("a"), []);
		assert.ok(calls.some(call => call.method === "DELETE" && call.url === `/api/attachments/${id}`));
		await render("b");
		await render("a");
		assert.deepEqual(chips(), []);
	});

	it("a send accepted by an earlier visit removes the chip a later visit restored", async () => {
		await render("a");
		await attach(pdf());
		await finishUploads();
		const first = latest;
		const send = await first.prepare("hello");
		await render("b");
		await render("a"); // Back before the send's response arrived: the chip is restored
		assert.deepEqual(chips(), ["notes.pdf"]);
		await act(async () => { first.accept(send!); }); // the earlier visit's send was accepted
		assert.deepEqual(chips(), []);
		assert.deepEqual(stored("a"), []);
	});
});

it("deleting the session clears its stored attachments for good", () => {
	storeAttachment("doomed", { id: randomUUID(), name: "notes.pdf", at: Date.now(), mimeType: "application/pdf", size: 3 });
	storeAttachment("b", { id: randomUUID(), name: "other.pdf", at: Date.now(), mimeType: "application/pdf", size: 3 });
	beginSessionDelete("doomed")(true);
	assert.deepEqual(stored("doomed"), []);
	assert.equal(stored("b").length, 1, "another session's stays");
});

const row = (name: string, extra: object = {}) => ({ id: randomUUID(), name, at: Date.now(), mimeType: "application/pdf", size: 9, ...extra });
const keep = (chatId: string, ...rows: ReturnType<typeof row>[]) => { for (const each of rows) { storeAttachment(chatId, each); statusOf.set(each.id, 204); } };
const waitMs = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

describe("round 1 review of #410", () => {
	it("Send waits until the saved attachments are loaded or ruled out, never going without them", async () => {
		const saved = row("notes.pdf");
		keep("late-info", saved);
		let release!: () => void;
		holdInfo = new Promise(resolve => { release = resolve; });
		await render("late-info");
		assert.equal(latest.restoring(), true, "server info is slow: the chip isn't there yet, and Send must wait");
		assert.deepEqual(chips(), []);
		let woke = false;
		void latest.restored().then(() => { woke = true; });
		await settle();
		assert.equal(woke, false);
		release();
		await settle();
		assert.equal(woke, true);
		assert.equal(latest.restoring(), false);
		assert.deepEqual(chips(), ["notes.pdf"]);
		assert.deepEqual((await latest.prepare("x"))?.attachmentUploadIds, [saved.id]);
	});

	it("nothing saved means nothing to wait for", async () => {
		await render("nothing-saved");
		assert.equal(latest.restoring(), false);
	});

	it("server info that fails, answers 503 or hangs still restores the saved chips unchecked, so Send never drops them", async () => {
		for (const [name, arrange] of [
			["unreachable", () => { infoFailure = true; }],
			["503", () => { infoStatus = 503; }],
			["hanging", () => { holdInfo = new Promise(() => {}); restoreTimeouts.info = 40; }],
		] as const) {
			infoFailure = false; infoStatus = 200; holdInfo = null;
			const chatId = `info-${name}`;
			const saved = row("kept.pdf");
			keep(chatId, saved);
			arrange();
			await render(chatId);
			if (name === "hanging") assert.equal(latest.restoring(), true, "Send waits while server info is pending");
			await waitMs(150);
			await latest.restored();
			assert.equal(latest.restoring(), false, name);
			assert.deepEqual(chips(), ["kept.pdf"], `${name}: the chip is restored without a status check`);
			assert.deepEqual((await latest.prepare("x"))?.attachmentUploadIds, [saved.id], name);
			assert.deepEqual(stored(chatId).map(each => each.id), [saved.id], name);
			assert.equal(calls.some(call => call.url.startsWith(`/api/attachments/${saved.id}`)), false, `${name}: no status check was possible`);
		}
	});

	it("a status check that hangs keeps the chip once it times out", async () => {
		const saved = row("slow.pdf");
		keep("hung-check", saved);
		holdStatus = new Promise(() => {});
		restoreTimeouts.check = 40;
		await render("hung-check");
		assert.deepEqual(chips(), ["slow.pdf"]);
		const sending = latest.prepare("x");
		await waitMs(150);
		assert.deepEqual((await sending)?.attachmentUploadIds, [saved.id], "the send is not stuck behind the hung check");
		assert.equal(statusSignals[0]?.aborted, true, "the check was cut off");
	});

	it("Remove of a restored chip aborts its status check and still releases it", async () => {
		const saved = row("removed.pdf");
		keep("remove-restored", saved);
		holdStatus = new Promise(() => {});
		await render("remove-restored");
		const selected = latest.current();
		let unavailable = 0;
		const sending = latest.prepare("x", () => { unavailable++; }, selected);
		await act(async () => { latest.remove(selected[0]!); });
		assert.equal(await sending, null, "the waiting send ends instead of staying occupied");
		assert.equal(unavailable, 1);
		assert.equal(statusSignals[0]?.aborted, true);
		await waitMs(20);
		assert.ok(calls.some(call => call.method === "DELETE" && call.url === `/api/attachments/${saved.id}`), "released without waiting for the check");
		assert.deepEqual(stored("remove-restored"), []);
	});

	it("a 404 that lands after Send was pressed stops the send, whatever is left", async () => {
		for (const name of ["one chip", "two chips, one gone"]) {
			const chatId = `send-404-${name.length}`;
			const gone = row("gone.pdf");
			const survivor = row("survivor.pdf");
			keep(chatId, ...(name === "one chip" ? [gone] : [gone, survivor]));
			let release!: () => void;
			holdIds.set(gone.id, new Promise(resolve => { release = resolve; }));
			await render(chatId);
			const selected = latest.current(); // what the learner saw when pressing Send
			assert.equal(selected.length, name === "one chip" ? 1 : 2, name);
			statusOf.delete(gone.id); // the server no longer has it
			let unavailable = 0;
			const sending = latest.prepare("same draft", () => { unavailable++; }, selected);
			await act(async () => { release(); });
			assert.equal(await act(async () => await sending), null, `${name}: the send stops instead of going with ${name === "one chip" ? "no files" : "only the survivor"}`);
			assert.equal(unavailable, 1, name);
		}
	});

	it("leaving mid-upload sends one release; a 409 is final because the server removes the transfer when it settles", async () => {
		await render("leaver");
		await attach(pdf());
		assert.equal(transfers.length, 1);
		const id = latest.files[0]!.grant!.id;
		deleteAnswers = [409];
		await render("elsewhere");
		await waitMs(300);
		assert.equal(calls.filter(call => call.method === "DELETE" && call.url === `/api/attachments/${id}`).length, 1);
	});

	it("a reload or close while an upload runs releases it with a keepalive DELETE, and leaves finished uploads alone", async () => {
		await render("reloader");
		await attach(pdf("done.pdf"));
		await finishUploads();
		await attach(pdf("running.pdf"));
		const running = latest.files.find(row => row.name === "running.pdf")!.grant!.id;
		const done = latest.files.find(row => row.name === "done.pdf")!.grant!.id;
		await act(async () => { window.dispatchEvent(new window.Event("pagehide")); });
		const deletes = calls.filter(call => call.method === "DELETE");
		assert.deepEqual(deletes.map(call => [call.url, call.keepalive]), [[`/api/attachments/${running}`, true]]);
		assert.equal(deletes.some(call => call.url.endsWith(done)), false);
		assert.deepEqual(stored("reloader").map(row => row.id), [done], "the finished one is still saved");
	});

	it("Remove aborts a running transfer and releases it", async () => {
		await render("remover");
		await attach(pdf());
		assert.equal(transfers.length, 1);
		const running = latest.files[0]!;
		await act(async () => { latest.remove(running); });
		await waitMs(20);
		assert.equal(transfers.length, 0, "the transfer was aborted");
		assert.ok(calls.some(call => call.method === "DELETE" && call.url === `/api/attachments/${running.grant!.id}`));
	});

	it("an upload that finishes after its session was deleted saves nothing and is released", async () => {
		await render("deleted-late");
		await attach(pdf());
		const id = latest.files[0]!.grant!.id;
		beginSessionDelete("deleted-late")(true); // confirmed; the view hasn't unmounted yet
		await finishUploads();
		assert.equal(values.has(keyOf("deleted-late")), false, "no key is written for a deleted session");
		assert.deepEqual(readStoredAttachments("deleted-late"), []);
		assert.deepEqual(chips(), []);
		await waitMs(20);
		assert.ok(calls.some(call => call.method === "DELETE" && call.url === `/api/attachments/${id}`), "the server's copy is released");
		storeAttachment("deleted-late", row("again.pdf"));
		assert.equal(values.has(keyOf("deleted-late")), false, "later writes are ignored too");
	});

	it("deleting a session removes its key whatever it holds, even a corrupt or expired value", () => {
		values.set(keyOf("corrupt-doomed"), "{corrupt");
		values.set(keyOf("expired-doomed"), JSON.stringify({ rows: [row("old.pdf", { at: Date.now() - 30 * 60 * 60_000 })] }));
		beginSessionDelete("corrupt-doomed")(true);
		beginSessionDelete("expired-doomed")(true);
		assert.equal(values.has(keyOf("corrupt-doomed")), false);
		assert.equal(values.has(keyOf("expired-doomed")), false);
	});

	it("expired keys are cleared before a write, so they cannot fill the quota that refuses it", () => {
		values.set(keyOf("long-gone"), JSON.stringify({ rows: [row("old.pdf", { at: Date.now() - 30 * 60 * 60_000, name: "x".repeat(200) })] }));
		quota = values.get(keyOf("long-gone"))!.length + 50; // room for the new key only once the old one is gone
		const fresh = row("fresh.pdf");
		storeAttachment("roomy", fresh);
		assert.deepEqual(readStoredAttachments("roomy").map(each => each.id), [fresh.id]);
	});

	it("Chat sends what the learner saw, and not before the saved attachments are loaded (wiring; the hook tests cover the rules)", () => {
		const source = readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
		assert.match(source, /const rows = attachments\.current\(\), waiting = attachments\.restoring\(\);\n\t+void prepareText\(undefined, undefined, undefined, rows\.length \|\| waiting \? \{ rows, waiting \} : undefined\);/);
		// The wait is inside the submission: text captured at the click, and a change while waiting cancels (also while a restored chip's check is pending; tests/chat-attachment-send.test.tsx drives that).
		assert.match(source, /const changedWhileWaiting = \(\) => composerEditRevision\.current !== capturedRevision \|\| !isInteractionScopeEligible\(sessionFindScopeRef\.current, controller\);/);
		assert.match(source, /await attachments\.restored\(\);\s*attempt\.check\(\);\s*if \(changedWhileWaiting\(\)\) \{ attempt\.cancel\(\); return false; \}\s*selected = attachments\.current\(\);/);
		assert.match(source, /if \(upload && changedWhileWaiting\(\)\) \{ attempt\.cancel\(\); return false; \}/);
		assert.match(source, /attachments\.prepare\(JSON\.stringify\(input\), \(\) => attempt\.cancel\(\), selected\)/);
		assert.doesNotMatch(source, /attachments\.restored\(\)\.then/, "no deferred send outside the submission runner");
	});

	it("leaving the session aborts a status check still in flight", async () => {
		keep("slow-check", row("notes.pdf"));
		holdStatus = new Promise(() => {}); // never answers
		await render("slow-check");
		assert.equal(statusSignals.length, 1);
		assert.equal(statusSignals[0]?.aborted, false);
		await render("elsewhere");
		assert.equal(statusSignals[0]?.aborted, true);
	});
});

describe("stored attachment state reads tolerantly (AGENTS.md)", () => {
	const good = (extra: object = {}) => ({ id: randomUUID(), name: "ok.pdf", at: Date.now(), mimeType: "application/pdf", size: 3, ...extra });
	const put = (value: unknown) => values.set(keyOf("a"), typeof value === "string" ? value : JSON.stringify(value));

	it("an old draft with no attachments, or only text, reads as none", () => {
		assert.deepEqual(readStoredAttachments("a"), []);
		values.set("lh:composer-draft:v1:a", JSON.stringify({ text: "hi", at: Date.now() }));
		assert.deepEqual(readStoredAttachments("a"), []);
	});

	it("unparsable or other-shape values read as none", () => {
		for (const value of ["{corrupt", "null", "42", "\"rows\"", "[]", { rows: "no" }, { rows: null }, { rows: {} }, {}, ""]) {
			put(value);
			assert.deepEqual(readStoredAttachments("a"), [], JSON.stringify(value));
		}
	});

	it("keeps the good rows and drops each malformed one", () => {
		const keep = good({ name: "keep.pdf" });
		const folder = good({ name: "Folder", mimeType: undefined, size: undefined, files: [{ path: "a", mimeType: "text/plain", size: 1 }] });
		put({ rows: [
			keep, folder,
			null, 7, "x", [],
			good({ id: "not-a-uuid" }), good({ id: 5 }), good({ name: "" }), good({ name: 5 }), good({ name: "n".repeat(256) }),
			good({ at: "yesterday" }), good({ at: null }), good({ at: Number.NaN }),
			good({ at: Date.now() - 25 * 60 * 60_000 }), // past the server's 24 hours
			good({ mimeType: 3 }), good({ size: -1 }), good({ size: 1.5 }), good({ size: "9" }),
			good({ mimeType: undefined, size: undefined, files: [] }),
			good({ mimeType: undefined, size: undefined, files: "a" }),
			good({ mimeType: undefined, size: undefined, files: [{ path: 1, mimeType: "a", size: 1 }] }),
			good({ mimeType: undefined, size: undefined, files: [null] }),
			keep, // a duplicate id
		] });
		assert.deepEqual(readStoredAttachments("a").map(row => row.name), ["keep.pdf", "Folder"]);
	});

	it("storage that throws reads as none and never throws on write", () => {
		const real = Object.getOwnPropertyDescriptor(window, "localStorage")!;
		const broken = { get length(): number { throw new Error("blocked"); }, key() { throw new Error("blocked"); }, getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("blocked"); } };
		Object.defineProperty(window, "localStorage", { configurable: true, value: broken });
		try {
			assert.deepEqual(readStoredAttachments("a"), []);
			assert.doesNotThrow(() => storeAttachment("a", good()));
			assert.doesNotThrow(() => dropStoredAttachments("a", ["x"]));
			assert.doesNotThrow(() => forgetStoredAttachments("stuck"));
		} finally { Object.defineProperty(window, "localStorage", real); }
	});

	it("a stale session's expired rows are pruned by a later write, and a deleted session's go for good", () => {
		values.set(keyOf("old"), JSON.stringify({ rows: [good({ at: Date.now() - 30 * 60 * 60_000 })] }));
		values.set(keyOf("junk"), "{corrupt");
		storeAttachment("a", good());
		assert.equal(values.has(keyOf("old")), false);
		assert.equal(values.has(keyOf("junk")), false);
		assert.equal(readStoredAttachments("a").length, 1);
		forgetStoredAttachments("a");
		assert.equal(values.has(keyOf("a")), false);
	});
});
