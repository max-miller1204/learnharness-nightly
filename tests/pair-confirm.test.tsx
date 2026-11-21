/**
 * The pairing screen asks before a link replaces a session (issue #303,
 * docs/specs/login-pairing.md "Pair page"). Any site can open
 * `/pair#token=<its own code>` as a top-level page, and the page posts the
 * code from this origin, so a signed-in browser must choose first.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { PairScreen } from "../components/pair-screen.tsx";
import { plainLinkStep } from "../lib/browser-pair-handoff.ts";

const dom = parseHTML("<html><body></body></html>");
let href = "";
let replacedWith: string | undefined;
let focusedId: string | null = null;
const location = {
	get href() { return href; },
	get pathname() { return new URL(href).pathname; },
	get host() { return new URL(href).host; },
	replace(url: string) { replacedWith = url; },
	reload() { replacedWith = "(reload)"; },
};
Object.defineProperty(dom.window, "location", { configurable: true, value: location });
Object.defineProperty(dom.window, "history", { configurable: true, value: { state: null, replaceState: (_s: unknown, _t: string, url: string) => { href = new URL(url, href).href; } } });
dom.window.HTMLElement.prototype.focus = function () { focusedId = this.getAttribute("data-testid"); };
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });

type Session = "signed-in" | "signed-out" | "broken";
let session: Session = "signed-out";
let posts: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const route = String(input);
	if (route === "/api/auth/session") {
		if (session === "broken") return Response.json({}, { status: 503 });
		return Response.json({ authenticated: session === "signed-in" });
	}
	if (route === "/api/auth/browser-session" && init?.method === "POST") {
		posts.push(JSON.parse(String(init.body)).credential);
		return Response.json({ authenticated: true });
	}
	throw new Error(`unexpected request ${route}`);
}) as typeof fetch;
process.on("exit", () => { globalThis.fetch = realFetch; });

let root: Root | undefined;
let host: HTMLDivElement | undefined;
async function settle() {
	for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function open(url: string, as: Session) {
	href = url; session = as; posts = []; replacedWith = undefined; focusedId = null;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(<PairScreen />); });
	await settle();
}
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const shown = (id: string) => byId(id) !== null;
async function click(id: string) {
	await act(async () => { byId(id)!.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })); });
	await settle();
}
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; host?.remove(); });

const CODE = "ABCDEFGHJKLM";

describe("a plain pairing link", () => {
	it("asks a signed-in browser first; Cancel keeps the session and spends nothing", async () => {
		await open(`https://box.tail.ts.net:8443/pair#token=${CODE}`, "signed-in");
		assert.equal(new URL(href).hash, "", "the code left the address bar first");
		assert.equal(shown("pair-confirm"), true, "the confirmation is shown");
		assert.deepEqual(posts, [], "nothing was redeemed on its own");
		assert.match(byId("pair-confirm")?.textContent ?? "", /already signed in to box\.tail\.ts\.net:8443/);
		// Keyboard: two real buttons, Cancel focused, neither taken out of the tab order.
		assert.equal(focusedId, "pair-confirm-cancel");
		for (const id of ["pair-confirm-cancel", "pair-confirm-accept"]) {
			assert.equal(byId(id)?.tagName, "BUTTON", id);
			assert.notEqual(byId(id)?.getAttribute("tabindex"), "-1", id);
		}
		assert.equal(byId("pair-confirm-accept")?.textContent, "Sign in with this link");
		await click("pair-confirm-cancel");
		assert.deepEqual(posts, []);
		assert.equal(replacedWith, "/", "Cancel loads the app in the current session");
	});

	it("signs in with the link only after the person chooses it", async () => {
		await open(`https://box.tail.ts.net:8443/pair#token=${CODE}`, "signed-in");
		await click("pair-confirm-accept");
		assert.deepEqual(posts, [CODE]);
		assert.equal(replacedWith, "/");
	});

	it("asks too when the session check fails, and pairs at once when signed out", async () => {
		await open(`http://localhost:3000/pair#token=${CODE}`, "broken");
		assert.equal(shown("pair-confirm"), true);
		assert.match(byId("pair-confirm")?.textContent ?? "", /Couldn.t check/);
		assert.deepEqual(posts, []);
		await act(async () => { root?.unmount(); }); root = undefined; host?.remove();

		await open(`http://localhost:3000/pair#token=${CODE}`, "signed-out");
		assert.equal(shown("pair-confirm"), false);
		assert.deepEqual(posts, [CODE], "a signed-out browser pairs in one step (QR in a phone browser, the startup link)");
		assert.equal(replacedWith, "/");
	});

	it("treats the ?token= fallback the same way", async () => {
		await open(`http://localhost:3000/pair?token=${CODE}`, "signed-in");
		assert.equal(shown("pair-confirm"), true);
		assert.deepEqual(posts, []);
	});
});

describe("a handoff link from the phone app (#token=…&chat=…)", () => {
	it("never replaces a session: signed in it opens the chat, signed out it pairs in one step", async () => {
		await open(`https://box.tail.ts.net:8443/pair#token=${CODE}&chat=chat_123`, "signed-in");
		assert.equal(shown("pair-confirm"), false);
		assert.deepEqual(posts, []);
		assert.equal(replacedWith, "/chat/chat_123");
		await act(async () => { root?.unmount(); }); root = undefined; host?.remove();

		await open(`https://box.tail.ts.net:8443/pair#token=${CODE}&chat=chat_123`, "signed-out");
		assert.deepEqual(posts, [CODE]);
		assert.equal(replacedWith, "/chat/chat_123");
	});
});

describe("plainLinkStep", () => {
	it("redeems only for a browser known to have no session", async () => {
		const answer = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
		assert.equal(await plainLinkStep(answer({ authenticated: false })), "redeem");
		assert.equal(await plainLinkStep(answer({ authenticated: true })), "confirm");
		assert.equal(await plainLinkStep(answer({}, 503)), "unchecked");
		assert.equal(await plainLinkStep(answer({ authenticated: "yes" })), "unchecked");
		assert.equal(await plainLinkStep((async () => { throw new Error("offline"); }) as unknown as typeof fetch), "unchecked");
	});
});
