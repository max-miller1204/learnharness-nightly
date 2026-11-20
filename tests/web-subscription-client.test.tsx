import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { parseHTML } from "linkedom";
import { createNotifyHub } from "../components/server-events.tsx";
import { createWebChatGPTBridge, createWebNativeBridge } from "../components/settings/subscription-client.ts";
import { createRequire } from "node:module";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document });
const originalFetch = globalThis.fetch;
const action = "/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000001";
afterEach(() => { globalThis.fetch = originalFetch; delete window.lh; });

test("web ChatGPT reserves a new tab before async login, navigates only to an opaque action and receives push/resync", async () => {
	const calls: string[] = [];
	const tab = { opener: {}, closed: false, location: { href: "about:blank" }, close() { this.closed = true; } };
	window.open = (() => { calls.push("tab"); return tab; }) as unknown as typeof window.open;
	const safe = { available: true, pending: true, allowBackgroundUse: true, activeId: null, accounts: [], error: null };
	globalThis.fetch = async (url, options) => {
		assert.equal(url, "/api/subscriptions"); assert.equal(new Headers(options?.headers).get("x-learnharness-subscriptions"), "1");
		if (!options?.method) return Response.json({ chatgpt: safe, native: [] });
		calls.push("login"); assert.equal(tab.opener, null);
		assert.deepEqual(JSON.parse(String(options.body)), { providerId: "chatgpt", op: "login" });
		return Response.json({ value: safe, browserAction: action });
	};
	const hub = createNotifyHub(), bridge = createWebChatGPTBridge(hub);
	assert.deepEqual(await bridge.login(), safe); assert.deepEqual(calls, ["tab", "login"]);
	assert.equal(tab.location.href, action); assert(!tab.closed);
	let updates = 0; const off = bridge.onChange(() => updates++);
	hub.dispatch("subscriptions-changed", "{}"); hub.fireOpen(); assert.equal(updates, 2);
	off(); hub.fireOpen(); assert.equal(updates, 2);
	assert.deepEqual(await bridge.status(), safe);
});

test("blocked popups do not start OAuth; failed login closes the reserved tab", async () => {
	const bridge = createWebChatGPTBridge(null);
	window.open = () => null;
	globalThis.fetch = async () => assert.fail("blocked popup must not start sign-in");
	await assert.rejects(bridge.login(), /Allow a sign-in tab/);
	const tab = { opener: {}, closed: false, close() { this.closed = true; } };
	window.open = (() => tab) as unknown as typeof window.open;
	globalThis.fetch = async () => new Response(null, { status: 400 });
	await assert.rejects(bridge.login()); assert(tab.closed);
});

test("native web login retains device prompts; only the explicit Open browser action opens a tab", async () => {
	const requests: Record<string, unknown>[] = []; let tabs = 0;
	const tab = { opener: {}, closed: false, location: { href: "" }, close() {} };
	window.open = (() => { tabs++; return tab; }) as unknown as typeof window.open;
	globalThis.fetch = async (_url, options) => {
		const command = JSON.parse(String(options?.body)); requests.push(command);
		return Response.json(command.op === "open" ? { browserAction: action } : {});
	};
	const bridge = createWebNativeBridge(null);
	await bridge.login("github-copilot", false); assert.equal(tabs, 0);
	await bridge.respond("github-copilot", "attempt", "prompt", "");
	await bridge.open("github-copilot", "attempt", "action"); assert.equal(tabs, 1); assert.equal(tab.location.href, action);
	assert.deepEqual(requests, [{ providerId: "github-copilot", op: "login", enabled: false }, { providerId: "github-copilot", op: "respond", attemptId: "attempt", promptId: "prompt", value: "" }, { providerId: "github-copilot", op: "open", attemptId: "attempt", actionId: "action" }]);
});

test("Electron dev uses its narrow external-browser bridge, without attempting a renderer popup", async () => {
	const opened: string[] = [];
	window.lh = { expandWindow() {}, subscriptionTransport: "web", openSubscriptionBrowser: async (target) => { opened.push(target); } };
	window.open = () => assert.fail("Electron denies renderer popups");
	globalThis.fetch = async () => Response.json({ value: { pending: true }, browserAction: action });
	await createWebChatGPTBridge(null).login(); assert.deepEqual(opened, [action]);
});

test("web notices identify the server machine; ChatGPT no longer requires a same-machine browser; desktop copy stays unchanged", async () => {
	const { CHATGPT_NOTICE, chatGPTNotice } = await import("../components/settings/chatgpt-connection.tsx");
	const { subscriptionNotice, subscriptionDisconnectCopy } = await import("../components/settings/subscription-connections.tsx");
	assert.equal(chatGPTNotice(), CHATGPT_NOTICE); assert(CHATGPT_NOTICE.includes("on this device"));
	assert(chatGPTNotice(true).includes("on the machine running LearnHarness"));
	assert(!chatGPTNotice(true).includes("same machine"), "paste-back lets sign-in finish from another device");
	for (const label of ["GitHub Copilot", "Grok"]) {
		assert(subscriptionNotice(label).includes("stored locally")); assert(subscriptionDisconnectCopy(label).includes("from this device"));
		assert(subscriptionNotice(label, true).includes("on the machine running LearnHarness"));
		assert(subscriptionDisconnectCopy(label, true).includes("from the machine running LearnHarness"));
	}
});

const require = createRequire(import.meta.url);
const { openWebSubscriptionBrowser } = require("../electron/web-subscription-browser.cjs");
test("desktop-dev opener accepts only local action IDs, does not follow redirects or use browser cookies", async () => {
	const opened: string[] = [];
	const options = {
		openExternal: async (url: string) => { opened.push(url); },
		fetch: async (url: URL, init: RequestInit) => {
			assert.equal(url.origin, "http://localhost:3000"); assert.equal(url.pathname, "/api/subscriptions/browser");
			assert.equal(init.method, "POST"); assert.equal(init.redirect, "manual"); assert.equal(init.credentials, "omit");
			assert.equal(new Headers(init.headers).get("origin"), "http://localhost:3000");
			return new Response(null, { status: 303, headers: { Location: "https://auth.openai.com/authorize?state=fixture" } });
		},
	};
	await openWebSubscriptionBrowser(action, "http://localhost:3000", options); assert.equal(opened.length, 1);
	for (const target of ["https://unrelated.invalid", "//unrelated.invalid", "/api/keys", `${action}&target=evil`]) await assert.rejects(openWebSubscriptionBrowser(target, "http://localhost:3000", options), /Invalid sign-in action/);
	for (const target of ["file:///private/fixture", "http://unrelated.invalid", "https://user:pass@unrelated.invalid"]) await assert.rejects(openWebSubscriptionBrowser(action, "http://localhost:3000", { ...options, fetch: async () => new Response(null, { status: 303, headers: { Location: target } }) }));
	assert.equal(opened.length, 1);
});

test("in the desktop app's window onto a server, ChatGPT login uses its sign-in bridge: no tab, no paste-back login", async () => {
	const pending = { available: true, pending: true, allowBackgroundUse: true, activeId: null, accounts: [], error: null };
	const signedIn = { ...pending, pending: false, activeId: "a", accounts: [{ id: "a", email: "x@example.invalid", registration: "r", connected: true }] };
	let current: unknown = pending;
	const posts: unknown[] = [];
	globalThis.fetch = async (_url, options) => {
		if (options?.method) { posts.push(JSON.parse(String(options.body))); return Response.json({}); }
		return Response.json({ chatgpt: current, native: [] });
	};
	window.open = () => assert.fail("the desktop bridge needs no tab");
	const asked: unknown[] = [];
	const ok = { ok: true };
	let reply: unknown = ok;
	window.lh = { chatgptSignIn: async (accountId?: string) => { asked.push(accountId); if (reply === ok) current = signedIn; return reply as { ok: true }; } };
	const bridge = createWebChatGPTBridge(null);
	assert.deepEqual(await bridge.login(), signedIn, "the server's status after the desktop's sign-in");
	assert.deepEqual(await bridge.login("0b0c2a4e-6d8f-4a1b-9c3d-5e7f9a1b3c5d"), signedIn);
	assert.deepEqual(asked, [undefined, "0b0c2a4e-6d8f-4a1b-9c3d-5e7f9a1b3c5d"]);
	assert.deepEqual(posts, [], "the page never starts the server's login itself");
	reply = { error: "Couldn’t reserve the local ChatGPT callback port." };
	current = { ...pending, pending: false };
	assert.deepEqual(await bridge.login(), { ...pending, pending: false, error: "Couldn’t reserve the local ChatGPT callback port." });
	reply = "nonsense";
	assert.equal((await bridge.login()).error, "ChatGPT sign-in failed. Try again.");
	// Without the bridge (a browser, a phone): the tab and paste-back flow.
	delete window.lh;
	let tabs = 0;
	window.open = (() => { tabs++; return { opener: {}, closed: false, location: { href: "" }, close() {} }; }) as unknown as typeof window.open;
	globalThis.fetch = async (_url, options) => options?.method ? Response.json({ value: pending, browserAction: action }) : Response.json({ chatgpt: pending, native: [] });
	assert.deepEqual(await createWebChatGPTBridge(null).login(), pending);
	assert.equal(tabs, 1);
});
