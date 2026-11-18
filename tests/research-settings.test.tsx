import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import type { AgentSettings } from "../src/core/index.ts";
import { SEARCH_ENGINES, SUBSCRIPTION_SEARCH_ENGINES, type SubscriptionSearchOption } from "../src/core/search.ts";
import { installModalDom } from "./modal-dom.ts";

const unavailableSubscriptions: SubscriptionSearchOption[] = SUBSCRIPTION_SEARCH_ENGINES.map(({ id }) => ({
	id, available: false, reason: "Subscription search unavailable.",
}));

it("keyless settings keep Research interactive and let the user select a connected subscription", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const reason = "No search engine is configured.";
	const bodies: Record<string, unknown> = {
		"/api/search": { available: false, engine: null, reason, subscriptions: [
			{ id: "chatgpt", available: true, reason: "Uses plan allowance or credits.", account: { label: "test@example.invalid", selection: "selected-account" } },
			...unavailableSubscriptions.filter(({ id }) => id !== "chatgpt"),
		] },
		"/api/keys": { keys: SEARCH_ENGINES.map(({ envVar }) => ({ id: envVar, present: false })) },
		"/api/models": { models: [], slots: { strong: null, cheap: null, vision: null } },
		"/api/settings/prompts": { prober: [], teacher: [], practice: [] },
	};
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => {
			assert.ok(url in bodies, `unexpected request: ${url}`);
			return new Response(JSON.stringify(bodies[url]));
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const restoreModalDom = installModalDom(dom);
	const root = createRoot(document.getElementById("root")!);
	let written: AgentSettings | undefined;
	try {
		await act(async () => {
			root.render(<InteractionLayersProvider><AgentSection
				agent={{ tools: { research: true } }}
				models={undefined}
				graph={undefined}
				compaction={undefined}
				onSectionChange={(next) => { written = next; return true; }}
				onModelsChange={() => {}}
				onCompactionChange={() => true}
			/></InteractionLayersProvider>);
		});
		const row = document.querySelector<HTMLElement>('[data-testid="tool-row-research"]')!;
		const toggle = row.querySelector<HTMLButtonElement>('[data-testid="toggle-tool-research"]')!;
		assert.ok(toggle);
		assert.equal(toggle.hasAttribute("disabled"), false);
		assert.equal(toggle.getAttribute("aria-checked"), "true");
		assert.ok(!row.className.includes("opacity-40"));
		assert.ok(!row.textContent?.includes(reason), "search setup hint is no longer a research-disable hint");
		act(() => { toggle.click(); });
		assert.equal(written?.tools?.research, false, "the keyless toggle emits the same stored boolean");
		const engine = document.querySelector<HTMLButtonElement>('[data-testid="search-engine-trigger"]')!;
		assert.ok(document.querySelector('[data-testid="search-engine-row"]')?.textContent?.includes(reason));
		assert.equal(engine.disabled, false);
		await act(async () => engine.click());
		const chatgpt = document.querySelector<HTMLButtonElement>('[data-testid="engine-option-chatgpt"]')!;
		assert.equal(chatgpt.disabled, false);
		assert.match(chatgpt.textContent ?? "", /test@example\.invalid/);
		assert.match(chatgpt.textContent ?? "", /plan allowance or credits/);
		const grok = document.querySelector<HTMLButtonElement>('[data-testid="engine-option-xai-subscription"]')!;
		assert.equal(grok.disabled, true);
		assert.match(grok.textContent ?? "", /Subscription search unavailable/);
		act(() => chatgpt.click());
		assert.deepEqual(written?.search, { engine: "chatgpt", accountSelection: "selected-account" });
	} finally {
		act(() => { root.unmount(); });
		restoreModalDom();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});

for (const { id, label, envVar } of SEARCH_ENGINES) {
it(`a ${label}-only key enables the engine menu and selecting ${label} saves the pin`, async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const bodies: Record<string, unknown> = {
		"/api/search": { available: true, engine: id, reason: `search engine: ${id} (auto)`, subscriptions: unavailableSubscriptions },
		"/api/keys": { keys: [{ id: envVar, present: true }] },
		"/api/models": { models: [], slots: { strong: null, cheap: null, vision: null } },
		"/api/settings/prompts": { prober: [], teacher: [], practice: [] },
	};
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element,
		CustomEvent: dom.window.CustomEvent,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => new Response(JSON.stringify(bodies[url])),
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const restoreModalDom = installModalDom(dom);
	const root = createRoot(document.getElementById("root")!);
	let written: AgentSettings | undefined;
	try {
		await act(async () => root.render(<InteractionLayersProvider><AgentSection agent={undefined} models={undefined} graph={undefined} compaction={undefined}
			onSectionChange={(next) => { written = next; return true; }} onModelsChange={() => {}} onCompactionChange={() => true} /></InteractionLayersProvider>));
		const trigger = document.querySelector<HTMLButtonElement>('[data-testid="search-engine-trigger"]')!;
		assert.ok(!trigger.hasAttribute("disabled"));
		await act(async () => trigger.click());
		const optionIds = [...document.querySelectorAll('[data-testid^="engine-option-"]')].map((row) => row.getAttribute("data-testid"));
		assert.deepEqual(optionIds, ["engine-option-auto", ...[...SEARCH_ENGINES, ...SUBSCRIPTION_SEARCH_ENGINES].map(({ id }) => `engine-option-${id}`)]);
		const option = document.querySelector<HTMLButtonElement>(`[data-testid="engine-option-${id}"]`);
		assert.ok(option);
		assert.ok(option.textContent?.includes(label));
		assert.match(option.textContent ?? "", /key/);
		act(() => option.click());
		assert.deepEqual(written?.search, { engine: id });
		await act(async () => trigger.click());
		const auto = document.querySelector<HTMLButtonElement>('[data-testid="engine-option-auto"]')!;
		assert.ok(auto);
		act(() => auto.click());
		assert.equal(written?.search, undefined, "Automatic clears the explicit pin");
	} finally {
		act(() => root.unmount());
		restoreModalDom();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});
}
