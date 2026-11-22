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
import { DraftAttachmentChips, useAttachmentDraft, type AttachmentDraft } from "../components/attachment-draft.tsx";
import { beginSessionDelete } from "../components/session-deletion.ts";
import { ATTACHMENT_DRAFT_KEY_PREFIX, dropStoredAttachments, forgetStoredAttachments, readStoredAttachments, storeAttachment } from "../lib/attachment-drafts.ts";

const values = new Map<string, string>();
const storage = {
	get length() { return values.size; },
	key: (i: number) => [...values.keys()][i] ?? null,
	getItem: (key: string) => values.get(key) ?? null,
	setItem: (key: string, value: string) => { values.set(key, value); },
	removeItem: (key: string) => { values.delete(key); },
};
const keyOf = (id: string) => ATTACHMENT_DRAFT_KEY_PREFIX + id;
const stored = (id: string) => values.has(keyOf(id)) ? (JSON.parse(values.get(keyOf(id))!) as { rows: { id: string; name: string }[] }).rows : [];

interface Call { method: string; url: string }
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
	values.clear(); calls = []; transfers = []; statusOf = new Map(); grants = 0; statusFailure = false; holdStatus = null;
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
			calls.push({ method, url });
			if (url === "/.well-known/learnharness/server") return Response.json({ capabilities });
			if (method === "POST" && url === "/api/attachments") {
				const id = randomUUID();
				statusOf.set(id, 204);
				grants++;
				return Response.json({ id, uploadUrl: `/upload/${id}`, expiresAt: Date.now() + 600_000 }, { status: 201 });
			}
			if (method === "DELETE") { statusOf.delete(url.split("/").pop()!); return new Response(null, { status: 204 }); }
			if (method === "GET" && url.startsWith("/api/attachments/")) {
				await holdStatus;
				if (statusFailure) throw new TypeError("offline");
				return new Response(null, { status: statusOf.get(decodeURIComponent(url.slice("/api/attachments/".length).split("?")[0]!)) ?? 404 });
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
	storeAttachment("a", { id: randomUUID(), name: "notes.pdf", at: Date.now(), mimeType: "application/pdf", size: 3 });
	storeAttachment("b", { id: randomUUID(), name: "other.pdf", at: Date.now(), mimeType: "application/pdf", size: 3 });
	beginSessionDelete("a")(true);
	assert.deepEqual(stored("a"), []);
	assert.equal(stored("b").length, 1, "another session's stays");
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
			assert.doesNotThrow(() => forgetStoredAttachments("a"));
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
