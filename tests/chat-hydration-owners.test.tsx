/**
 * Issue #366 through the production owners of PathInput: text typed into a
 * server-rendered field before hydration must survive the owners' own mount
 * effects (ChatSessionComposer, ReadingThinkingField and Chat reset their
 * state from their first value in layout effects, after the field's), so
 * Send is enabled, Enter sends, the saved draft stays out of the way, and a
 * submitted check carries the reading notes.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Chat } from "../components/chat.tsx";
import { ChatSessionComposer } from "../components/composer.tsx";
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
const storedText = (id: string) => { const raw = values.get(keyOf(id)); return raw === undefined ? undefined : (JSON.parse(raw) as { text: string }).text; };
const posts: { url: string; body: unknown }[] = []; // every request that isn't a read

let heldStream: ReadableStreamDefaultController<Uint8Array> | undefined; // an open reattach stream: the turn keeps running
let fixture: Awaited<ReturnType<typeof mountPluginChrome>> | undefined;
let savedObserver: PropertyDescriptor | undefined;
let savedSession: PropertyDescriptor | undefined;
afterEach(async () => {
	try { heldStream?.close(); } catch { /* already closed */ }
	heldStream = undefined;
	await fixture?.close();
	fixture = undefined;
	flushComposerDrafts();
	if (savedObserver) Object.defineProperty(globalThis, "ResizeObserver", savedObserver); else Reflect.deleteProperty(globalThis, "ResizeObserver");
	if (savedSession) Object.defineProperty(globalThis, "sessionStorage", savedSession); else Reflect.deleteProperty(globalThis, "sessionStorage");
});
beforeEach(() => { values.clear(); session.clear(); posts.length = 0; });

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (id: string, content: unknown[]) => ({ id, role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "synthetic", timestamp: 1, stopReason: "toolUse", usage, content }) as unknown as LhMessage;
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, toolCallId: string, toolName: string, details?: unknown) => ({ id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "Synthetic tool completed." }], ...(details ? { details } : {}), isError: false, timestamp: 2 }) as unknown as LhMessage;
const quiz = { type: "check", nodeId: "addition", question: "What is 1 + 1?", options: [{ value: "two", label: "2" }, { value: "three", label: "3" }], explanation: "Adding one to one gives two.", correctAnswer: "two" };
const user = { id: "sent_user", role: "user", content: "Start", timestamp: 0 } as unknown as LhMessage;
const waitingOnCheck = [user, assistant("m_probe", [{ type: "text", text: "Lesson." }, call("call_probe", "probe_done", { assessment: { strands: [{ strand: "Addition", assessment: "Ready." }] } })]), result("m_probe_result", "call_probe", "probe_done", { ok: true }), assistant("m_quiz", [call("call_quiz", "quiz", quiz)])];

const model = { provider: "fixture", id: "fixture-model", name: "Fixture", input: ["text", "image"], reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
const TYPED = "typed before hydration";
type Props = Partial<React.ComponentProps<typeof Chat>>;
/** Server-render the session, type into `selector`'s field, then hydrate. */
async function hydrate(selector: string, props: Props = {}, saved?: string) {
	savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	savedSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
	Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: mapStorage(session) });
	if (saved !== undefined) values.set(keyOf("a"), JSON.stringify({ text: saved, at: Date.now() }));
	const before: { field?: Element } = {};
	fixture = await mountPluginChrome({ activate() {} }, <Chat chatId="a" title="Session a" initialMessages={[]} {...props} />, {
		pathname: "/chat/a",
		hydrate: {
			beforeHydration(document) {
				const typedInto = document.querySelector(selector);
				assert.ok(typedInto, `the server render has ${selector}`);
				before.field = typedInto;
				typedInto.replaceChildren(document.createTextNode(TYPED)); // typed before any listener existed
			},
		},
		prepareDom(dom) {
			const prototype = dom.window.HTMLElement.prototype;
			const saved = [[dom.window, "location"], [dom.window, "localStorage"], [prototype, "getAnimations"], [prototype, "animate"]].map(([object, key]) => ({ object: object as object, key: key as string, descriptor: Object.getOwnPropertyDescriptor(object, key as string) }));
			Object.defineProperty(dom.window, "location", { configurable: true, value: new URL("http://fixture/chat/a") });
			Object.defineProperty(dom.window, "localStorage", { configurable: true, value: mapStorage(values) });
			Object.defineProperty(prototype, "getAnimations", { configurable: true, value: () => [] });
			Object.defineProperty(prototype, "animate", { configurable: true, value: () => ({ cancel() {}, finish() {}, finished: Promise.resolve() }) });
			return () => { for (const { object, key, descriptor } of saved) { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); } };
		},
		fetch: async (input, init) => {
			const url = String(input);
			if ((init?.method ?? "GET") !== "GET") posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			const chat = /^\/api\/chats\/(\w+)$/.exec(url);
			if (chat) return Response.json({ id: chat[1], messages: [] });
			if (url === "/api/models") return Response.json({ providers: [{ id: "fixture", keyPresent: true }], models: [model], slots: Object.fromEntries(["strong", "cheap", "vision"].map((slot) => [slot, { model: { provider: model.provider, id: model.id } }])) });
			if (url === "/api/settings") return Response.json({});
			if (/^\/api\/chats\/\w+\/side-chats$/.test(url)) return Response.json({ threads: [] });
			if (url.startsWith("/api/jobs?chatId=")) return Response.json({ jobs: [], turnInFlight: false });
			if (/^\/api\/chats\/\w+\/stream$/.test(url)) return new Response(new ReadableStream<Uint8Array>({ start(controller) { heldStream = controller; } }), { headers: { "content-type": "text/event-stream" } });
			if (/^\/api\/chats\/\w+\/steer$/.test(url) || url === "/api/activity/abort") return Response.json({ ok: true });
			if (url === "/api/chat") return Response.json({ error: "no model in this fixture" }, { status: 500 });
			assert.fail(`Unexpected fixture request: ${url}`);
		},
	});
	await settle();
	const field = fixture.document.querySelector<HTMLElement>(selector)!;
	assert.equal(field, before.field, "hydration keeps the element the learner typed into");
	assert.deepEqual(fixture.recoverableErrors, [], "no hydration error");
	return field;
}
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2)); });
const COMPOSER = '[data-testid="composer"] [data-file-path-input]';
const READING = '[data-testid="reading-thinking-field"] [data-file-path-input]';
const button = (label: string) => fixture!.document.querySelector<HTMLButtonElement>(`[data-testid="composer"] button[aria-label="${label}"]`);
const press = (field: HTMLElement, init: Record<string, unknown>) => act(async () => {
	const event = new (fixture!.document.defaultView as unknown as { Event: typeof Event }).Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, init);
	field.dispatchEvent(event);
});

describe("text typed before hydration, through the production owners", () => {
	it("keeps the text in the composer, enables Send and leaves the saved draft out of it", { timeout: 30_000 }, async () => {
		const field = await hydrate(COMPOSER, {}, "an older saved draft");
		assert.equal(field.textContent, TYPED);
		assert.equal(button("Send")?.disabled, false, "Send is enabled for the typed text");
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); flushComposerDrafts(); });
		assert.equal(storedText("a"), TYPED, "the typed text is the saved draft");
	});

	it("keeps the text with no saved draft and Enter sends it", { timeout: 30_000 }, async () => {
		const field = await hydrate(COMPOSER);
		assert.equal(field.textContent, TYPED);
		assert.equal(button("Send")?.disabled, false);
		await press(field, { key: "Enter" });
		await settle();
		assert.ok(posts.some((post) => post.url === "/api/chat" && JSON.stringify(post.body).includes(TYPED)), `Enter sends the typed text: ${JSON.stringify(posts)}`);
	});

	it("steers with the typed text while a turn runs, and never stops it", { timeout: 30_000 }, async () => {
		const field = await hydrate(COMPOSER, { initialMessages: [user], initiallyInFlight: true });
		assert.equal(field.textContent, TYPED);
		assert.ok(heldStream, "the turn's reattach stream is still open");
		assert.ok(button("Send"), "the button is Send (steer)");
		assert.equal(button("Stop"), null, "the button is not Stop");
		await press(field, { key: "Enter" });
		await settle();
		assert.ok(posts.some((post) => post.url.endsWith("/steer") && JSON.stringify(post.body).includes(TYPED)), `Enter steers with the typed text: ${JSON.stringify(posts)}`);
		assert.ok(!posts.some((post) => post.url === "/api/activity/abort"), "the turn is not aborted");
	});

	it("keeps reading notes typed before hydration and submits them with the check", { timeout: 30_000 }, async () => {
		const field = await hydrate(READING, { initialMessages: waitingOnCheck });
		assert.equal(field.textContent, TYPED);
		const doc = fixture!.document;
		await press(field, { key: "Enter" }); // opens the waiting check, as the learner would
		await settle();
		assert.equal(field.textContent, TYPED, "opening the check keeps the notes");
		const radio = [...doc.querySelectorAll<HTMLElement>('[data-testid="question-dock"] [role="radio"]')].find((el) => el.querySelector("p")?.textContent === "2");
		assert.ok(radio, "the check's options are on screen");
		await fixture!.click(radio);
		const form = doc.querySelector<HTMLFormElement>('[data-testid="question-dock"] form')!;
		await act(async () => { form.dispatchEvent(new (doc.defaultView as unknown as { Event: typeof Event }).Event("submit", { bubbles: true, cancelable: true })); });
		await settle();
		const sent = posts.find((post) => post.url === "/api/chat");
		assert.ok(sent, `the check was submitted: ${JSON.stringify(posts)}`);
		assert.ok(JSON.stringify(sent.body).includes(`"readingThinking":"${TYPED}"`), `the answer carries the reading notes: ${JSON.stringify(sent.body)}`);
	});
});

describe("ChatSessionComposer hydrated on its own", () => {
	/** The owner keeps the value it first rendered, as Chat does until something re-renders it. */
	async function hydrateComposer(busy: boolean) {
		savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
		Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
		const changes: string[] = [];
		const sends: number[] = [];
		const stops: number[] = [];
		fixture = await mountPluginChrome({ activate() {} }, <ChatSessionComposer busy={busy} value="" revision={0} onChange={(v) => changes.push(v)} onSend={() => sends.push(1)} onStop={() => stops.push(1)} sendAllowed dictationActive={false} />, {
			hydrate: { beforeHydration(document) { document.querySelector("[data-file-path-input]")!.replaceChildren(document.createTextNode(TYPED)); } },
			prepareDom(dom) {
				const prototype = dom.window.HTMLElement.prototype;
				Object.defineProperty(prototype, "getAnimations", { configurable: true, value: () => [] });
			},
		});
		await settle();
		return { changes, sends, stops, field: fixture.document.querySelector<HTMLElement>("[data-file-path-input]")! };
	}

	it("enables Send for the typed text and Enter sends it", { timeout: 30_000 }, async () => {
		const { changes, sends, field } = await hydrateComposer(false);
		assert.equal(field.textContent, TYPED);
		assert.deepEqual(fixture!.recoverableErrors, []);
		assert.equal(button("Send")?.disabled, false, "Send is enabled");
		assert.deepEqual(changes, [TYPED]);
		await press(field, { key: "Enter" });
		assert.equal(sends.length, 1, "Enter sends");
	});

	it("shows Send, not Stop, while busy, so Enter steers rather than stops", { timeout: 30_000 }, async () => {
		const { sends, stops, field } = await hydrateComposer(true);
		assert.equal(field.textContent, TYPED);
		assert.ok(button("Send"), "the button is Send");
		assert.equal(button("Stop"), null);
		await press(field, { key: "Enter" });
		assert.deepEqual({ sends: sends.length, stops: stops.length }, { sends: 1, stops: 0 });
	});
});
