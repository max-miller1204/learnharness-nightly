/**
 * Issue #347 through the production Chat: a draft typed in session A comes
 * back after visiting session B and returning (each visit remounts Chat, as
 * app/chat/[id]/page.tsx keys it by session), B never shows A's draft, a
 * restored draft is never saved back, a corrupt stored value gives an empty
 * composer, and an owed opening message wins over an older draft, whether it
 * comes by ?prompt= or by SessionStarter's sessionStorage handover.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Chat } from "../components/chat.tsx";
import { stashOpeningPrompt } from "../components/opening-prompt.ts";
import { COMPOSER_DRAFT_KEY_PREFIX, flushComposerDrafts } from "../lib/composer-drafts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";

const values = new Map<string, string>(); // localStorage
const session = new Map<string, string>(); // sessionStorage
const mapStorage = (map: Map<string, string>) => ({
	get length() { return map.size; },
	key: (i: number) => [...map.keys()][i] ?? null,
	getItem: (key: string) => map.get(key) ?? null,
	setItem: (key: string, value: string) => { map.set(key, value); },
	removeItem: (key: string) => { map.delete(key); },
});
const keyOf = (id: string) => COMPOSER_DRAFT_KEY_PREFIX + id;
const writes: string[] = []; // every request that isn't a read (a send would be one)
const storedText = (id: string) => { const raw = values.get(keyOf(id)); return raw === undefined ? undefined : (JSON.parse(raw) as { text: string }).text; };
const saveDraft = (id: string, text: string) => values.set(keyOf(id), JSON.stringify({ text, at: Date.now() }));

let fixture: Awaited<ReturnType<typeof mountPluginChrome>> | undefined;
let savedObserver: PropertyDescriptor | undefined;
let savedSession: PropertyDescriptor | undefined;
beforeEach(async () => {
	values.clear(); session.clear(); writes.length = 0;
	savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	savedSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
	Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: mapStorage(session) });
	fixture = await mountPluginChrome({ activate() {} }, null, {
		pathname: "/chat/a",
		prepareDom(dom) {
			const prototype = dom.window.HTMLElement.prototype;
			const saved = [[dom.window, "location"], [dom.window, "localStorage"], [prototype, "getAnimations"]].map(([object, key]) => ({ object: object as object, key: key as string, descriptor: Object.getOwnPropertyDescriptor(object, key as string) }));
			Object.defineProperty(dom.window, "location", { configurable: true, value: new URL("http://fixture/chat/a") });
			Object.defineProperty(dom.window, "localStorage", { configurable: true, value: mapStorage(values) });
			Object.defineProperty(prototype, "getAnimations", { configurable: true, value: () => [] });
			return () => { for (const { object, key, descriptor } of saved) { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); } };
		},
		fetch: async (input, init) => {
			const url = String(input);
			if ((init?.method ?? "GET") !== "GET") writes.push(`${init?.method} ${url}`);
			const chat = /^\/api\/chats\/(\w+)$/.exec(url);
			if (chat) return Response.json({ id: chat[1], messages: [] });
			if (url === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
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
	flushComposerDrafts();
	if (savedObserver) Object.defineProperty(globalThis, "ResizeObserver", savedObserver); else Reflect.deleteProperty(globalThis, "ResizeObserver");
	if (savedSession) Object.defineProperty(globalThis, "sessionStorage", savedSession); else Reflect.deleteProperty(globalThis, "sessionStorage");
});

const open = (id: string, props: { prompt?: string; messages?: LhMessage[] } = {}) =>
	fixture!.render(<Chat key={id} chatId={id} title={`Session ${id}`} initialMessages={props.messages ?? []} initialPrompt={props.prompt} />);
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2)); });
const composer = () => {
	const editor = fixture!.document.querySelector<HTMLElement>("[data-file-path-input]");
	assert.ok(editor, "the session's composer is on screen");
	return editor;
};
const type = async (value: string) => { await act(async () => { composer().textContent = value; composer().dispatchEvent(new window.Event("input", { bubbles: true })); }); };
const conversation: LhMessage[] = [
	{ role: "user", content: "an earlier goal", timestamp: 1 } as LhMessage,
	{ role: "assistant", content: [{ type: "text", text: "an earlier reply" }], api: "openai-completions", provider: "fixture", model: "fixture", timestamp: 2, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as LhMessage,
];

describe("the composer draft in the production Chat", () => {
	it("survives leaving the session and coming back, per session", async () => {
		await open("a");
		assert.equal(composer().textContent, "");
		await type("half a thought about A");
		await open("b"); // navigate away: A unmounts and saves its draft
		assert.equal(composer().textContent, "", "B never shows A's draft");
		await type("B's own draft");
		await open("a"); // Back
		assert.equal(composer().textContent, "half a thought about A");
		await open("b");
		assert.equal(composer().textContent, "B's own draft");
		await open("a");
		await type("");
		await open("b");
		await open("a");
		assert.equal(composer().textContent, "", "an emptied composer leaves no draft");
	});

	it("never saves a restored draft back: a send from another tab stays cleared", async () => {
		saveDraft("a", "old");
		await open("a");
		assert.equal(composer().textContent, "old");
		values.delete(keyOf("a")); // another tab sent it
		await open("b"); // leaving A flushes
		await settle();
		assert.equal(storedText("a"), undefined);
	});

	it("gives an empty composer for a corrupt stored value", async () => {
		values.set(keyOf("a"), "{corrupt");
		await open("a");
		assert.equal(composer().textContent, "");
	});

	it("puts an owed opening message (sessionStorage handover, no ?prompt=) ahead of an older draft; a failed delivery leaves it in the composer", async () => {
		saveDraft("a", "an older draft");
		assert.ok(stashOpeningPrompt("a", "the opening message"));
		await open("a"); // the session the page is on: its opening runs
		await settle();
		// No models are set up here, so delivery is refused and the opening message waits in the composer.
		assert.equal(composer().textContent, "the opening message");
		await open("b"); // leaving saves it
		assert.equal(storedText("a"), "the opening message", "it is now the session's draft");
	});

	it("shows an interrupted opening (already attempted) for the learner to resend, never reposting it", async () => {
		assert.ok(stashOpeningPrompt("a", "the opening message", true));
		await open("a"); // the session the page is on: its opening runs
		await settle();
		assert.equal(composer().textContent, "the opening message");
		assert.deepEqual(writes, [], "nothing was sent");
	});

	it("keeps the learner's edit of a failed opening over the stashed opening text when they come back (#362 round 2)", async () => {
		assert.ok(stashOpeningPrompt("a", "the opening message"));
		await open("a");
		await settle();
		assert.equal(composer().textContent, "the opening message", "delivery failed: the text waits for a retry");
		await type("the opening message, edited for the retry");
		await open("b"); // leaving saves the edit
		assert.equal(storedText("a"), "the opening message, edited for the retry");
		await open("a"); // back: the attempted handover is still stashed
		await settle();
		assert.equal(composer().textContent, "the opening message, edited for the retry", "the edit wins");
		await open("b");
		assert.equal(storedText("a"), "the opening message, edited for the retry", "and isn't overwritten");
		assert.deepEqual(writes, [], "a failed opening is never reposted");
	});

	it("restores the draft of an established session opened from an old ?prompt= link", async () => {
		saveDraft("d", "the draft of an established session");
		await open("d", { prompt: "a long-sent opening", messages: conversation });
		await settle();
		assert.equal(composer().textContent, "the draft of an established session");
	});
});
