import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { configureWebSubscriptionRuntime } from "../src/agent/subscription-runtime.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-grok-search-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;
delete process.env.LH_GROK_SEARCH_PROBE;
const { ClaudeSearchCollector, claudeSearchArgs, parseClaudeAccount, searchClaudeCode } = await import("../src/agent/claude-code/search.ts");
const { searchPickerStatus, searchProvider } = await import("../src/server/search.ts");
const { claudeSearchSeams } = await import("../src/server/subscription-search.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { saveKey } = await import("../src/server/keys.ts");
const { piModels } = await import("../src/agent/models.ts");

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(directory, { recursive: true, force: true });
});

const planStatus = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "scratch@example.invalid", orgId: "org-a", subscriptionType: "max" };

test("Claude Code account label and selection come from auth status and change with the account", () => {
	const plan = parseClaudeAccount(JSON.stringify(planStatus))!;
	assert.equal(plan.label, "scratch@example.invalid · Claude Max");
	assert.equal(plan.plan, true);
	assert.match(plan.selection, /^[0-9a-f]{32}$/);
	assert.notEqual(parseClaudeAccount(JSON.stringify({ ...planStatus, email: "other@example.invalid" }))!.selection, plan.selection);
	const api = parseClaudeAccount(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }))!;
	assert.equal(api.label, "Claude Code account · api_key", "the label is never blank");
	assert.equal(api.plan, false);
	assert.equal(parseClaudeAccount(JSON.stringify({ loggedIn: false })), null);
	assert.equal(parseClaudeAccount("not json"), null);
});

test("headless search enables only WebSearch and parses native links", () => {
	const args = claudeSearchArgs();
	assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "WebSearch"]);
	assert.deepEqual(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 2), ["--allowedTools", "WebSearch"]);
	assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4), ["--model", "haiku", "--effort", "low"]);
	assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-session-persistence"));

	const guarded = new ClaudeSearchCollector(5);
	assert.match(guarded.add(JSON.stringify({ type: "system", subtype: "init", tools: ["WebSearch", "Bash"] }))!, /restrict this search/);
	assert.throws(() => guarded.finish(), /restrict this search/);
	assert.equal(new ClaudeSearchCollector(5).add(JSON.stringify({ type: "system", subtype: "init", tools: ["WebSearch", "EndConversation"] })), undefined);

	const collector = new ClaudeSearchCollector(2);
	collector.add(JSON.stringify({ type: "system", subtype: "init", tools: ["WebSearch"] }));
	collector.add(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch" }] } }));
	collector.add(JSON.stringify({ type: "user", tool_use_result: { results: [
		{ tool_use_id: "srvtoolu_1", content: [{ title: "First", url: "https://example.org/a" }, { title: "Unsafe", url: "javascript:alert(1)" }, { title: "Dup", url: "https://example.org/a" }] },
		"model summary text",
	] } }));
	collector.add(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: 'Web search results for query: "q"\n\nLinks: [{"title":"","url":"https://example.org/b"},{"title":"C","url":"https://example.org/c"}]' }] } }));
	assert.deepEqual(collector.finish(), [
		{ title: "First", url: "https://example.org/a", snippet: "" },
		{ title: "https://example.org/b", url: "https://example.org/b", snippet: "" },
	]);

	assert.throws(() => new ClaudeSearchCollector(5).finish(), /did not report its tool list/, "a missing tool list fails closed");
	const started = () => {
		const collector = new ClaudeSearchCollector(5);
		collector.add(JSON.stringify({ type: "system", subtype: "init", tools: ["WebSearch"] }));
		return collector;
	};
	assert.throws(() => started().finish(), /did not run a native web search/);
	const empty = started();
	empty.add(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch" }] } }));
	assert.throws(() => empty.finish(), /without source links/);
	const toolFailed = started();
	toolFailed.add(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch" }] } }));
	toolFailed.add(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "Web search is not enabled for this organization" }] } }));
	assert.throws(() => toolFailed.finish(), /web search failed: Web search is not enabled/);
	assert.equal(started().add(JSON.stringify({ type: "assistant", message: { content: { not: "an array" } } })), undefined, "malformed content does not throw");
	const limited = new ClaudeSearchCollector(5);
	limited.add(JSON.stringify({ type: "result", is_error: true, result: "Claude usage limit reached. Your limit resets at 5pm." }));
	assert.throws(() => limited.finish(), /usage limit reached/);
	const signedOut = new ClaudeSearchCollector(5);
	assert.match(signedOut.add(JSON.stringify({ type: "assistant", error: "authentication_failed", message: { content: [] } }))!, /claude auth login/);
});

test("an abort ends a hung CLI even when a grandchild holds its output open", async () => {
	let cwd = "";
	let child: ReturnType<typeof spawn> | undefined;
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 200);
	const started = Date.now();
	await assert.rejects(searchClaudeCode("query", 5, controller.signal, (_args, options) => {
		cwd = options.cwd;
		child = spawn("sh", ["-c", "sleep 30 & echo '{}'; sleep 30"], { cwd: options.cwd, stdio: "pipe" });
		return child as never;
	}), /abort/i);
	assert.ok(Date.now() - started < 5_000);
	assert.equal(child!.signalCode, "SIGKILL");
	assert.equal(fs.existsSync(cwd), false, "the temp directory is removed");
});

test("Claude Code search uses the selected CLI account, saves its links, and never falls back", async () => {
	let status: Record<string, unknown> = { ...planStatus };
	let lines: unknown[] = [];
	let runs = 0;
	let onRun: (() => void) | undefined;
	claudeSearchSeams.installation = async () => ({ state: "meets-minimum", version: "9.9.9", minimumVersion: "2.1.259" });
	claudeSearchSeams.account = async () => parseClaudeAccount(JSON.stringify(status));
	claudeSearchSeams.run = (args, options) => {
		runs++;
		assert.ok(args.includes("WebSearch"));
		assert.equal(options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
		onRun?.();
		const script = `process.stdin.resume();process.stdin.on("end",()=>{for(const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))})console.log(l)});`;
		return spawn(process.execPath, ["-e", script], { cwd: options.cwd, stdio: "pipe" });
	};
	globalThis.fetch = async () => { throw new Error("no keyed fallback request is allowed"); };
	assert.equal(saveKey("TAVILY_API_KEY", "tvly-scratch-never-fallback").ok, true);

	writeSettings({ version: 1 });
	assert.match((await searchPickerStatus()).subscriptions[1]!.reason, /Enable Claude Code/);

	writeSettings({ version: 1, claudeCode: { enabled: true } });
	const option = (await searchPickerStatus()).subscriptions[1]!;
	assert.equal(option.available, true);
	assert.equal(option.account?.label, "scratch@example.invalid · Claude Max");
	assert.match(option.reason, /Claude plan usage/);

	const select = (accountSelection: string) => writeSettings({ version: 1, claudeCode: { enabled: true }, agent: { search: { engine: "claude-code", accountSelection } } });
	select(option.account!.selection);
	assert.match((await searchPickerStatus()).reason, /Claude Code subscription/);
	lines = [
		{ type: "system", subtype: "init", tools: ["WebSearch"] },
		{ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch" }] } },
		{ type: "user", tool_use_result: { results: [{ tool_use_id: "s", content: [{ title: "Native", url: "https://example.org/native" }] }] } },
		{ type: "result", subtype: "success", is_error: false, result: "done" },
	];
	assert.deepEqual(await searchProvider()!.search("query", 5), [{ title: "Native", url: "https://example.org/native", snippet: "" }]);
	assert.equal(runs, 1);

	onRun = () => { status = { ...planStatus, email: "switched@example.invalid" }; };
	await assert.rejects(searchProvider()!.search("query", 5), /Reselect Claude Code/, "a mid-run account switch discards the result");
	onRun = undefined;
	assert.equal(runs, 2);
	await assert.rejects(searchProvider()!.search("query", 5), /Reselect Claude Code/);
	assert.equal(runs, 2, "no CLI run after an account change");

	status = { ...planStatus, loggedIn: false };
	await assert.rejects(searchProvider()!.search("query", 5), /claude auth login/);
	status = { loggedIn: true, authMethod: "api_key" };
	const apiOption = (await searchPickerStatus()).subscriptions[1]!;
	assert.match(apiOption.reason, /signed in with api_key, so search may be billed/);
	select(apiOption.account!.selection);
	lines = [{ type: "system", subtype: "init", tools: ["WebSearch", "Bash"] }];
	await assert.rejects(searchProvider()!.search("query", 5), /restrict this search/);
	writeSettings({ version: 1, agent: { search: { engine: "claude-code", accountSelection: apiOption.account!.selection } } });
	await assert.rejects(searchProvider()!.search("query", 5), /Enable Claude Code/);
	assert.equal(runs, 3);
});

test("Grok search is offered only behind the probe switch and uses the OAuth lease with hosted search", async () => {
	writeSettings({ version: 1, agent: { search: { engine: "xai-subscription", accountSelection: "unused" } } });
	assert.match((await searchPickerStatus()).subscriptions[2]!.reason, /unavailable on the LearnHarness Grok OAuth connection/);
	await assert.rejects(searchProvider()!.search("query", 5), /unavailable on the LearnHarness Grok OAuth connection/);

	const catalog = piModels().getProvider("xai")!.getModels().filter(({ id }) => ["grok-4.5", "grok-4.3", "grok-4.7"].includes(id));
	assert.equal(catalog.length, 3);
	const xai = { providerId: "xai", available: true, connected: true, pending: false, allowBackgroundUse: true, connectionId: "scratch-connection", epoch: 1, authorityRevision: 1, revision: 1 };
	let leases = 0;
	configureWebSubscriptionRuntime(async <T>(channel: string, op: string, fields: Record<string, unknown>) => {
		assert.equal(channel, "lh:subscriptions");
		if (op === "snapshot") return { statuses: [structuredClone(xai)], models: { xai: catalog } } as T;
		assert.equal(op, "lease");
		assert.equal(fields.background, true);
		leases++;
		return { scope: fields.scope, auth: { apiKey: "scratch-grok-oauth" } } as T;
	});
	const bodies: Record<string, unknown>[] = [];
	let events: unknown[] = [];
	let status = 200;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, "https://api.x.ai/v1/responses");
		assert.equal(request.headers.get("authorization"), "Bearer scratch-grok-oauth");
		assert.equal(request.redirect, "error");
		bodies.push(await request.json());
		if (status !== 200) return new Response(JSON.stringify({ error: { message: "Search is not included in this plan" } }), { status, headers: { "Content-Type": "application/json" } });
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
	};

	process.env.LH_GROK_SEARCH_PROBE = "1";
	const option = (await searchPickerStatus()).subscriptions[2]!;
	assert.equal(option.available, true);
	assert.equal(option.account?.label, "Grok account");
	assert.match(option.reason, /Search probe/);
	writeSettings({ version: 1, agent: { search: { engine: "xai-subscription", accountSelection: option.account!.selection } } });
	events = [
		{ type: "response.web_search_call.completed", item_id: "search", output_index: 0 },
		{ type: "response.output_text.annotation.added", item_id: "m", content_index: 0, annotation: { type: "url_citation", url: "https://example.org/grok", title: "Grok source", start_index: 0, end_index: 4 } },
		{ type: "response.output_text.done", item_id: "m", content_index: 0, text: "Cite this" },
		{ type: "response.completed", response: { id: "r", status: "completed", output: [] } },
	];
	assert.deepEqual(await searchProvider()!.search("query", 5), [{ title: "Grok source", url: "https://example.org/grok", snippet: "Cite" }]);
	assert.equal(bodies[0]!.model, "grok-4.3", "the cheapest eligible model is chosen");
	assert.deepEqual(bodies[0]!.tools, [{ type: "web_search" }]);
	assert.equal(bodies[0]!.tool_choice, "required");

	status = 403;
	await assert.rejects(searchProvider()!.search("query", 5), /Provider response: .*not included in this plan/);
	assert.equal(bodies.length, 2, "a refusal is reported without a retry");
	assert.equal(leases, 2);
	xai.allowBackgroundUse = false;
	xai.revision++;
	await assert.rejects(searchProvider()!.search("query", 5), /Grok background use is off/);
	xai.allowBackgroundUse = true;
	xai.connectionId = "scratch-connection-2";
	xai.revision++;
	await assert.rejects(searchProvider()!.search("query", 5), /Reselect Grok/);
	assert.equal(bodies.length, 2);
	delete process.env.LH_GROK_SEARCH_PROBE;
});
