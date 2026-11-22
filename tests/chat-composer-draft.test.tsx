/**
 * Issue #347 through the production Chat: a draft typed in session A comes
 * back after visiting session B and returning (each visit remounts Chat, as
 * app/chat/[id]/page.tsx keys it by session), B never shows A's draft, a
 * corrupt stored value gives an empty composer, and an opening prompt
 * (/chat/<id>?prompt=...) is not replaced by an older draft.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { Chat } from "../components/chat.tsx";
import { COMPOSER_DRAFTS_KEY, flushComposerDrafts } from "../lib/composer-drafts.ts";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";

test("a composer draft survives leaving the session and coming back, per session", async () => {
	const savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
	const values = new Map<string, string>();
	let fixture: Awaited<ReturnType<typeof mountPluginChrome>> | undefined;
	try {
		fixture = await mountPluginChrome({ activate() {} }, null, {
			pathname: "/chat/a",
			prepareDom(dom) {
				const prototype = dom.window.HTMLElement.prototype;
				const saved = [[dom.window, "location"], [dom.window, "localStorage"], [prototype, "getAnimations"]].map(([object, key]) => ({ object: object as object, key: key as string, descriptor: Object.getOwnPropertyDescriptor(object, key as string) }));
				Object.defineProperty(dom.window, "location", { configurable: true, value: new URL("http://fixture/chat/a") });
				Object.defineProperty(dom.window, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
				Object.defineProperty(prototype, "getAnimations", { configurable: true, value: () => [] });
				return () => { for (const { object, key, descriptor } of saved) { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); } };
			},
			fetch: async (input) => {
				const url = String(input);
				const chat = /^\/api\/chats\/(\w+)$/.exec(url);
				if (chat) return Response.json({ id: chat[1], messages: [] });
				if (url === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
				if (url === "/api/settings") return Response.json({});
				if (/^\/api\/chats\/\w+\/side-chats$/.test(url)) return Response.json({ threads: [] });
				if (url.startsWith("/api/jobs?chatId=")) return Response.json({ jobs: [], turnInFlight: false });
				assert.fail(`Unexpected fixture request: ${url}`);
			},
		});
		const mounted = fixture;
		const open = (id: string, prompt?: string) => mounted.render(<Chat key={id} chatId={id} title={`Session ${id}`} initialMessages={[]} initialPrompt={prompt} />);
		const composer = () => {
			const editor = mounted.document.querySelector<HTMLElement>("[data-file-path-input]");
			assert.ok(editor, "the session's composer is on screen");
			return editor;
		};
		const type = async (value: string) => { await act(async () => { composer().textContent = value; composer().dispatchEvent(new window.Event("input", { bubbles: true })); }); };

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

		await open("c", "the opening prompt");
		values.set(COMPOSER_DRAFTS_KEY, JSON.stringify({ version: 1, drafts: { d: { text: "an older draft", at: Date.now() } } }));
		await open("d", "the opening prompt");
		assert.notEqual(composer().textContent, "an older draft", "an opening prompt is never replaced by a saved draft");

		await mounted.render(null);
		flushComposerDrafts();
		values.set(COMPOSER_DRAFTS_KEY, "{corrupt");
		await open("a");
		assert.equal(composer().textContent, "", "a corrupt stored value gives an empty draft, no error");
	} finally {
		await fixture?.close();
		if (savedObserver) Object.defineProperty(globalThis, "ResizeObserver", savedObserver); else Reflect.deleteProperty(globalThis, "ResizeObserver");
	}
});
