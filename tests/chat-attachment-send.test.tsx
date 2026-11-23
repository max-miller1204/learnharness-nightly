/**
 * Issue #367 through the production Chat: a Send pressed while a restored
 * attachment's status check is pending, then an edit of the text before the
 * check answers, sends nothing and keeps the edited text and the chip. With
 * no edit the same Send goes out with the attachment.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Chat } from "../components/chat.tsx";
import { ATTACHMENT_DRAFT_KEY_PREFIX } from "../lib/attachment-drafts.ts";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";

const values = new Map<string, string>();
const storage = {
	get length() { return values.size; },
	key: (i: number) => [...values.keys()][i] ?? null,
	getItem: (key: string) => values.get(key) ?? null,
	setItem: (key: string, value: string) => { values.set(key, value); },
	removeItem: (key: string) => { values.delete(key); },
};
const posts: { url: string; body: string }[] = [];
let releaseStatus!: () => void;
let acceptPosts = false;
let savedSession: PropertyDescriptor | undefined;
let fixture: Awaited<ReturnType<typeof mountPluginChrome>> | undefined;
let savedObserver: PropertyDescriptor | undefined;
const saved = { id: randomUUID(), name: "notes.pdf" };

beforeEach(async () => {
	values.clear(); posts.length = 0; acceptPosts = false;
	savedSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
	const held = new Promise<void>(resolve => { releaseStatus = resolve; });
	savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
	values.set(ATTACHMENT_DRAFT_KEY_PREFIX + "a", JSON.stringify({ rows: [{ ...saved, at: Date.now(), mimeType: "application/pdf", size: 9 }] }));
	fixture = await mountPluginChrome({ activate() {} }, null, {
		pathname: "/chat/a",
		prepareDom(dom) {
			const prototype = dom.window.HTMLElement.prototype;
			const previous = [[dom.window, "location"], [dom.window, "localStorage"], [prototype, "getAnimations"]].map(([object, key]) => ({ object: object as object, key: key as string, descriptor: Object.getOwnPropertyDescriptor(object, key as string) }));
			Object.defineProperty(dom.window, "location", { configurable: true, value: new URL("http://fixture/chat/a") });
			Object.defineProperty(dom.window, "localStorage", { configurable: true, value: storage });
			Object.defineProperty(prototype, "getAnimations", { configurable: true, value: () => [] });
			return () => { for (const { object, key, descriptor } of previous) { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); } };
		},
		fetch: async (input, init) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url === "/.well-known/learnharness/server") return Response.json({ capabilities: ["attachment-uploads-v1", "attachment-status-v1"] });
			if (url.startsWith(`/api/attachments/${saved.id}?chatId=`)) { await held; return new Response(null, { status: 204 }); }
			if (method !== "GET") { posts.push({ url, body: String(init?.body ?? "") }); return acceptPosts ? new Response("", { status: 200 }) : Response.json({ error: "fixture does not run turns" }, { status: 500 }); }
			const chat = /^\/api\/chats\/(\w+)$/.exec(url);
			if (chat) return Response.json({ id: chat[1], messages: [] });
			if (url === "/api/models") return Response.json({ providers: [{ id: "custom", name: "Fixture", keyPresent: true, models: [] }], models: [], slots: {} });
			if (url === "/api/settings") return Response.json({});
			if (/^\/api\/chats\/\w+\/side-chats$/.test(url)) return Response.json({ threads: [] });
			if (url.startsWith("/api/jobs?chatId=")) return Response.json({ jobs: [], turnInFlight: false });
			assert.fail(`Unexpected fixture request: ${url}`);
		},
	});
});
afterEach(async () => {
	await fixture?.close();
	fixture = undefined;
	if (savedSession) Object.defineProperty(globalThis, "sessionStorage", savedSession); else Reflect.deleteProperty(globalThis, "sessionStorage");
	if (savedObserver) Object.defineProperty(globalThis, "ResizeObserver", savedObserver); else Reflect.deleteProperty(globalThis, "ResizeObserver");
});

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 2)); });
const editor = () => fixture!.document.querySelector<HTMLElement>("[data-file-path-input]")!;
const type = async (text: string) => { await act(async () => { editor().textContent = text; editor().dispatchEvent(new window.Event("input", { bubbles: true })); }); };
const chips = () => [...fixture!.document.querySelectorAll("[data-attachment-upload] span.truncate")].map(element => element.textContent);
const pressSend = () => act(async () => { fixture!.document.querySelector("[data-testid=\"composer\"]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });

describe("Send with a restored attachment whose status check is pending", () => {
	beforeEach(async () => {
		await fixture!.render(<Chat key="a" chatId="a" title="Session a" initialMessages={[]} />);
		await settle();
		assert.deepEqual(chips(), ["notes.pdf"], "the saved chip is restored while its check is pending");
		await type("the original text");
	});

	it("goes out with the attachment when nothing changed", async () => {
		await pressSend();
		assert.equal(posts.length, 0, "waiting on the check");
		releaseStatus();
		await settle();
		assert.equal(posts.length, 1);
		assert.ok(posts[0]!.body.includes(saved.id) && posts[0]!.body.includes("the original text"), posts[0]!.body);
	});

	it("is cancelled by an edit made while it waits, keeping the edited text and the chip", async () => {
		await pressSend();
		await type("the edited text");
		releaseStatus();
		await settle();
		assert.equal(posts.length, 0, "the original text and chip were not sent");
		assert.equal(editor().textContent, "the edited text");
		assert.deepEqual(chips(), ["notes.pdf"]);
	});
});

it("resends an interrupted opening with its restored attachment and clears the chip on acceptance", async () => {
	values.set("lh.openingPrompt.a", JSON.stringify({ text: "opening text", attempted: true }));
	acceptPosts = true;
	await fixture!.render(<Chat key="a" chatId="a" title="Session a" initialMessages={[]} />);
	await settle();
	assert.equal(editor().textContent, "opening text");
	await pressSend();
	assert.equal(posts.length, 0, "waits for the attachment status");
	releaseStatus();
	await settle();
	assert.equal(posts.length, 1);
	assert.ok(posts[0]!.body.includes(saved.id) && posts[0]!.body.includes("opening text"), posts[0]!.body);
	assert.deepEqual(chips(), []);
});
