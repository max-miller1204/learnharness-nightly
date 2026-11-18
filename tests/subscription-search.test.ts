import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { configureWebSubscriptionRuntime } from "../src/agent/subscription-runtime.ts";
import type { ChatGPTStatus } from "../src/core/contracts/chatgpt.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-subscription-search-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;
const { searchPickerStatus, searchProvider } = await import("../src/server/search.ts");
const { createWebTools } = await import("../src/agent/tools/web.ts");
const { parseSources } = await import("../src/agent/subagents/runner.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { saveKey } = await import("../src/server/keys.ts");

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(directory, { recursive: true, force: true });
});

test("shared search uses the bound OAuth account, preserves native sources, and fails closed", async () => {
	const first = { id: "scratch-a", email: "scratch-a@example.invalid", registration: "scratch-registration-a", connected: true, planEnabled: true };
	const second = { id: "scratch-b", email: "scratch-b@example.invalid", registration: "scratch-registration-b", connected: true, planEnabled: true };
	const status: ChatGPTStatus = {
		available: true, pending: false, allowBackgroundUse: true, activeId: first.id, accountSelection: "selection-a",
		accounts: [first, second], error: null,
	};
	let revision = 1;
	let leases = 0;
	let catalog = ["gpt-5", "gpt-6.2-astra", "gpt-5.6-luna", "gpt-6-luna"];
	let expectedModel = "gpt-6-luna";
	let beforeLease: (() => void) | undefined;
	configureWebSubscriptionRuntime(async <T>(channel: string, op: string, fields: Record<string, unknown>) => {
		assert.equal(channel, "lh:chatgpt");
		const stamp = { epoch: revision, authorityRevision: revision, revision };
		switch (op) {
			case "status":
				return { ...stamp, status: structuredClone(status) } as T;
			case "models":
				return { ...stamp, status: structuredClone(status), accountId: status.activeId, models: catalog.map((id) => ({
					id, name: id, contextWindow: 500_000, input: ["text"], reasoningLevels: ["low"],
				})) } as T;
			case "lease":
				leases++;
				assert.equal(fields.background, true);
				assert.equal(fields.expectedAccountId, first.id);
				assert.equal(fields.selectedModelId, expectedModel);
				beforeLease?.();
				return { ...stamp, accountId: status.activeId, accessToken: "scratch-oauth-only" } as T;
			default:
				throw new Error(`Unexpected operation ${op}`);
		}
	});

	const cited = {
		type: "message",
		content: [{ type: "output_text", text: "Evidence [fake](https://invented.example/)",
			annotations: [
				{ type: "url_citation", url: "https://example.org/article?a=1&b=2", title: "Actual source", start_index: 0, end_index: 8 },
				{ type: "url_citation", url: "javascript:alert(1)", title: "Unsafe source" },
			] }],
	};
	const native = { type: "web_search_call", status: "completed" };
	const complete = (output: unknown[]) => ({ type: "response.completed", response: { id: "scratch-response", status: "completed", output } });
	let event: unknown = complete([native, cited]);
	const urls: string[] = [];
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		urls.push(request.url);
		assert.equal(request.url, "https://api.openai.com/v1/responses");
		assert.equal(request.headers.get("authorization"), "Bearer scratch-oauth-only");
		assert.equal(request.redirect, "error");
		const body = await request.json();
		assert.equal(body.model, expectedModel);
		assert.equal(body.reasoning?.effort, "low");
		assert.equal(body.store, false);
		assert.equal(body.stream, true);
		assert.deepEqual(body.tools, [{ type: "web_search", search_context_size: "low" }]);
		assert.equal(body.tool_choice, "required");
		assert.match(JSON.stringify(body.input), /search query only/);
		return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
	};

	assert.equal(saveKey("TAVILY_API_KEY", "tvly-scratch-never-fallback").ok, true);
	const picker = await searchPickerStatus();
	assert.equal(picker.engine, "tavily");
	assert.equal(picker.subscriptions[0]?.account?.label, first.email);
	assert.deepEqual(picker.subscriptions.slice(1).map(({ available }) => available), [false, false, false]);
	assert.ok(!JSON.stringify(picker).includes("scratch-oauth-only"));

	const select = (accountSelection = "selection-a") => {
		writeSettings({ version: 1, agent: { search: { engine: "chatgpt", accountSelection } } });
	};
	select();
	const source = { title: "Actual source", url: "https://example.org/article?a=1&b=2" };
	const tools = createWebTools(searchProvider, (hits) => {
		assert.deepEqual(hits, [{ ...source, snippet: "Evidence" }]);
		assert.deepEqual(parseSources("Research brief with no rewritten URLs", [], hits.map(({ title, url }) => ({ title, url }))), [source]);
	});
	const result = await tools.web_search!.execute("scratch", { query: "search query only", count: 1 });
	assert.match(JSON.stringify(result.content), /example\.org/);
	assert.equal(typeof tools.web_fetch?.execute, "function");
	assert.deepEqual(urls, ["https://api.openai.com/v1/responses"]);

	const search = () => searchProvider()!.search("search query only", 5);
	event = { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } };
	await assert.rejects(search, /Check usage/);
	event = { type: "error", code: "unsupported_tool", message: "web_search" };
	await assert.rejects(search, /workspace policy/);
	event = complete([cited]);
	await assert.rejects(search, /did not complete a native web search/);
	event = complete([native]);
	await assert.rejects(search, /without cited sources/);
	assert.equal(urls.length, 5);

	status.allowBackgroundUse = false;
	revision++;
	await assert.rejects(search, /background use is off/);
	status.allowBackgroundUse = true;
	status.activeId = second.id;
	status.accountSelection = "selection-b";
	revision++;
	assert.match((await searchPickerStatus()).reason, /Reselect/);
	await assert.rejects(search, /Reselect/);
	status.activeId = first.id;
	status.accountSelection = "selection-a-again";
	revision++;
	await assert.rejects(search, /Reselect/);
	assert.equal(leases, 5);
	select("selection-a-again");
	beforeLease = () => {
		writeSettings({ version: 1, agent: { search: { engine: "tavily" } } });
	};
	await assert.rejects(search, /selection changed/);
	assert.equal(urls.length, 5, "stale settings block even after the lease was requested");

	select("selection-a-again");
	beforeLease = undefined;
	catalog = ["gpt-6.2-astra", "gpt-5", "gpt-5.6-luna"];
	expectedModel = "gpt-5.6-luna";
	revision++;
	event = complete([native, cited]);
	assert.deepEqual(await search(), [{ ...source, snippet: "Evidence" }], "the next smallest eligible model is selected when the best model is absent from the catalog");
	catalog = ["gpt-5"];
	revision++;
	await assert.rejects(search, /No ChatGPT search model/);
	first.connected = false;
	status.activeId = null;
	revision++;
	await assert.rejects(search, /Connect ChatGPT/);
	writeSettings({ version: 1, agent: { search: { engine: "xai-subscription" } } });
	await assert.rejects(search, /Grok OAuth connection/);
	assert.equal(urls.length, 6, "no failure may send a fallback request");
});
