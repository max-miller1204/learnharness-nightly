/**
 * Update-banner render tests (Wave C, 2026-10-10): the banner is a pure
 * function of the shell's observational status — hidden without a bridge
 * or snapshot/event, visible with the downloaded
 * status, Restart wired to the bridge. The subscribe effect only runs
 * client-side, so the SSR pass pins the hidden state; the pushed state is
 * exercised by mounting with the bridge stubbed (classic-JSX shim as in
 * render-sidebar.test.tsx).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as ReactDOMClient from "react-dom/client";
import { flushSync } from "react-dom";
import { parseHTML } from "linkedom";
import UpdateBanner from "../components/update-banner.tsx";
import type { UpdateState } from "../components/settings/update-settings.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";

// linkedom as the DOM for the interactive pass (first createRoot test in
// the repo — the banner's push→render→click flow needs real effects).
// The window.lh bridge type is declared globally by components/sidebar.tsx.
const dom = parseHTML("<html><body></body></html>");
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.document;

describe("update banner (Wave C)", () => {
	afterEach(() => {
		delete (window as { lh?: unknown }).lh;
	});

	it("renders nothing with no bridge (browser / SSR)", () => {
		const html = renderToStaticMarkup(<UpdateBanner />);
		assert.equal(html, "");
	});

	it("renders nothing when the bridge exists but no status has arrived", () => {
		const listeners: Array<(s: UpdateState) => void> = [];
		(window as { lh?: unknown }).lh = {
			onUpdateStatus: (cb: (s: UpdateState) => void) => {
				listeners.push(cb);
				return () => {};
			},
			installUpdate: () => {},
		};
		const html = renderToStaticMarkup(<UpdateBanner />);
		assert.equal(html, "");
		void listeners;
	});

	it("shows the version + Restart once the downloaded push arrives, and Restart installs", async () => {
		let pushed: ((s: UpdateState) => void) | null = null;
		let installed = 0;
		(window as { lh?: unknown }).lh = {
			onUpdateStatus: (cb: (s: UpdateState) => void) => {
				pushed = cb;
				return () => {};
			},
			installUpdate: () => {
				installed += 1;
			},
		};
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = ReactDOMClient.createRoot(host);
		flushSync(() => root.render(<UpdateBanner />));
		assert.equal(host.innerHTML, "", "hidden before the push");

		await new Promise((r) => setTimeout(r, 0));
		flushSync(() => pushed?.({ status: "downloaded", version: "0.3.1", revision: 1 }));
		assert.ok(host.innerHTML.includes("0.3.1"), "the version renders");
		assert.ok(host.innerHTML.includes("Restart"), "the restart affordance renders");

		const button = host.querySelector<HTMLButtonElement>("[data-testid='update-banner'] button");
		assert.ok(button, "restart button exists");
		button!.click();
		assert.equal(installed, 1, "Restart asks the shell to quit-and-install");
		root.unmount();
		host.remove();
	});

	it("self-hosted (no bridge): reads /api/updates, refetches on update-changed, Restart posts install", async () => {
		const calls: Array<{ url: string; method: string }> = [];
		const queue: UpdateState[] = [
			{ status: "idle", version: null, revision: 1 },
			{ status: "downloaded", version: "0.6.1-nightly.20261117.2", revision: 3 },
			// An older reply arriving late must not hide the newer state.
			{ status: "idle", version: null, revision: 2 },
		];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), method: init?.method ?? "GET" });
			const body = queue.shift() ?? { status: "downloaded", version: "0.6.1-nightly.20261117.2", revision: 4 };
			return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;
		const handlers = new Map<string, (data: string) => void>();
		const source: NotifySource = {
			close: () => {},
			onOpen: () => {},
			onEvent: (name, cb) => { handlers.set(name, cb); },
		};
		try {
			const host = document.createElement("div");
			document.body.appendChild(host);
			const root = ReactDOMClient.createRoot(host);
			flushSync(() => root.render(<ServerEventsProvider connect={() => source}><UpdateBanner /></ServerEventsProvider>));
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
			assert.equal(host.innerHTML, "", "idle: hidden");
			handlers.get("update-changed")?.("{}");
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
			assert.ok(host.innerHTML.includes("0.6.1-nightly.20261117.2"), "the downloaded version renders");
			assert.ok(host.innerHTML.includes("no agent is working"), "self-hosted wording");
			handlers.get("update-changed")?.("{}");
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
			assert.ok(host.innerHTML.includes("0.6.1-nightly.20261117.2"), "a stale revision is ignored");
			const button = host.querySelector<HTMLButtonElement>("[data-testid='update-banner'] button");
			button!.click();
			await new Promise((r) => setTimeout(r, 0));
			assert.deepEqual(calls.at(-1), { url: "/api/updates/install", method: "POST" });
			assert.ok(calls.slice(0, 3).every((c) => c.url === "/api/updates" && c.method === "GET"));
			root.unmount();
			host.remove();
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
