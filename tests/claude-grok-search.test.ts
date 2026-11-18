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
const { ClaudeSearchCollector, claudeSearchArgs, parseClaudeAccount, readClaudeAuthStatus, searchClaudeCode } = await import("../src/agent/claude-code/search.ts");
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
	const apiStatus = JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", configDirectory: "/scratch/claude" });
	const api = parseClaudeAccount(apiStatus, {}, () => null)!;
	assert.equal(api.label, "Claude Code account · api_key", "the label is never blank");
	assert.equal(api.plan, false);
	assert.equal(parseClaudeAccount(JSON.stringify(planStatus), { ANTHROPIC_API_KEY: "sk-ant-scratch-a" })!.selection, plan.selection, "a plan sign-in binds to its account, not to unrelated variables");
});

test("sign-ins without account identity bind to a one-way credential fingerprint", () => {
	const status = (method: string, provider = "firstParty") => JSON.stringify({ loggedIn: true, authMethod: method, apiProvider: provider, configDirectory: "/scratch/claude" });
	const selection = (method: string, env: Record<string, string>, settings: unknown = null, provider?: string) => {
		let read = "";
		const account = parseClaudeAccount(status(method, provider), env, (directory) => { read = directory; return settings; })!;
		assert.equal(read, "/scratch/claude", "the CLI's reported config directory holds its user settings");
		assert.doesNotMatch(JSON.stringify(account), /scratch-secret/, "no raw credential is kept");
		return account.selection;
	};
	const keyA = selection("api_key", { ANTHROPIC_API_KEY: "sk-ant-scratch-secret-a" });
	assert.equal(selection("api_key", { ANTHROPIC_API_KEY: "sk-ant-scratch-secret-a" }), keyA, "the same key keeps the selection");
	assert.notEqual(selection("api_key", { ANTHROPIC_API_KEY: "sk-ant-scratch-secret-b" }), keyA, "another key requires reselection");
	assert.notEqual(selection("api_key", { ANTHROPIC_API_KEY: "sk-ant-scratch-secret-a" }, { env: { ANTHROPIC_API_KEY: "sk-ant-scratch-secret-c" } }), keyA, "user settings env overrides the launch env");
	assert.notEqual(selection("oauth_token", { CLAUDE_CODE_OAUTH_TOKEN: "scratch-secret-a" }), selection("oauth_token", { CLAUDE_CODE_OAUTH_TOKEN: "scratch-secret-b" }));
	assert.notEqual(selection("api_key_helper", {}, { apiKeyHelper: "scratch-helper a" }), selection("api_key_helper", {}, { apiKeyHelper: "scratch-helper b" }), "the helper command text, never its output");
	const bedrock = (env: Record<string, string>) => selection("third_party", env, null, "bedrock");
	assert.notEqual(bedrock({ AWS_PROFILE: "a" }), bedrock({ AWS_PROFILE: "b" }));
	assert.notEqual(bedrock({ AWS_ACCESS_KEY_ID: "AKIA1" }), bedrock({ AWS_ACCESS_KEY_ID: "AKIA2" }));
	assert.notEqual(bedrock({ AWS_BEARER_TOKEN_BEDROCK: "scratch-secret-a" }), bedrock({ AWS_BEARER_TOKEN_BEDROCK: "scratch-secret-b" }));
	const vertex = (env: Record<string, string>) => selection("third_party", env, null, "vertex");
	assert.notEqual(vertex({ ANTHROPIC_VERTEX_PROJECT_ID: "a" }), vertex({ ANTHROPIC_VERTEX_PROJECT_ID: "b" }));
	assert.notEqual(vertex({ GOOGLE_APPLICATION_CREDENTIALS: "/a.json" }), vertex({ GOOGLE_APPLICATION_CREDENTIALS: "/b.json" }));
});

test("auth status runs from an empty private directory without LearnHarness keys", async () => {
	assert.equal(saveKey("ANTHROPIC_API_KEY", "sk-ant-scratch-learnharness-only-key").ok, true);
	assert.equal(process.env.ANTHROPIC_API_KEY, "sk-ant-scratch-learnharness-only-key", "the key store reflects the key into the server env");
	const fake = path.join(directory, "fake-claude");
	fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require("node:fs");\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), entries: fs.readdirSync("."), key: process.env.ANTHROPIC_API_KEY ?? null, mds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS }));\n`, { mode: 0o700 });
	const report = JSON.parse(await readClaudeAuthStatus(fake)) as { args: string[]; cwd: string; entries: string[]; key: string | null; mds: string };
	assert.deepEqual(report.args, ["auth", "status", "--json"]);
	assert.notEqual(path.resolve(report.cwd), path.resolve(os.tmpdir()), "a stray tmpdir .claude/settings.json is never read");
	assert.deepEqual(report.entries, []);
	assert.equal(fs.existsSync(report.cwd), false, "the directory is removed");
	assert.equal(report.key, null, "a LearnHarness-stored key never reaches the CLI");
	assert.equal(report.mds, "1");
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

test("an abort kills a hung CLI's whole process group and only then removes its directory", { skip: process.platform === "win32" }, async () => {
	let cwd = "";
	let child: ReturnType<typeof spawn> | undefined;
	const pidFile = path.join(directory, "grandchild.pid");
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 300);
	const started = Date.now();
	await assert.rejects(searchClaudeCode("query", 5, controller.signal, (_args, options) => {
		cwd = options.cwd;
		assert.equal(options.detached, true, "search starts the CLI in its own process group");
		child = spawn("sh", ["-c", 'sleep 30 & echo $! > "$1"; echo "{}"; sleep 30', "sh", pidFile], { cwd: options.cwd, stdio: "pipe", detached: options.detached });
		return child as never;
	}), /abort/i);
	assert.ok(Date.now() - started < 5_000);
	assert.equal(child!.signalCode, "SIGKILL");
	assert.equal(fs.existsSync(cwd), false, "the temp directory is removed");
	const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.throws(() => process.kill(grandchild, 0), { code: "ESRCH" }, "the CLI's subprocess does not outlive the kill");
});

test("a read error waits for the CLI to exit before removing its directory", async () => {
	let exitedBeforeRemoval: boolean | undefined;
	let child: ReturnType<typeof spawn> | undefined;
	await assert.rejects(searchClaudeCode("query", 5, undefined, (_args, options) => {
		child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: options.cwd, stdio: "pipe", detached: options.detached });
		const cwd = options.cwd;
		setTimeout(() => child!.stdout!.destroy(new Error("scratch read failure")), 100);
		child.once("exit", () => { exitedBeforeRemoval = fs.existsSync(cwd); });
		return child as never;
	}), /scratch read failure/);
	assert.equal(exitedBeforeRemoval, true, "the child exited while its directory still existed");
});

test("Claude Code search uses the selected CLI account, saves its links, and never falls back", async () => {
	let status: Record<string, unknown> = { ...planStatus };
	let lines: unknown[] = [];
	let runs = 0;
	let onRun: (() => void) | undefined;
	claudeSearchSeams.installation = async () => ({ state: "meets-minimum", version: "9.9.9", minimumVersion: "2.1.259" });
	claudeSearchSeams.account = async () => parseClaudeAccount(JSON.stringify(status), {}, () => null);
	claudeSearchSeams.run = (args, options) => {
		runs++;
		assert.ok(args.includes("WebSearch"));
		assert.equal(options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
		assert.equal(options.env.ANTHROPIC_API_KEY, undefined, "a LearnHarness-stored key never reaches the search CLI");
		onRun?.();
		const script = `process.stdin.resume();process.stdin.on("end",()=>{for(const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))})console.log(l)});`;
		return spawn(process.execPath, ["-e", script], { cwd: options.cwd, stdio: "pipe" });
	};
	globalThis.fetch = async () => { throw new Error("no keyed fallback request is allowed"); };
	assert.equal(saveKey("TAVILY_API_KEY", "tvly-scratch-never-fallback").ok, true);
	assert.equal(saveKey("ANTHROPIC_API_KEY", "sk-ant-scratch-learnharness-only-key").ok, true);

	writeSettings({ version: 1 });
	assert.match((await searchPickerStatus()).subscriptions[1]!.reason, /Enable Claude Code/);

	writeSettings({ version: 1, claudeCode: { enabled: true } });
	const option = (await searchPickerStatus()).subscriptions[1]!;
	assert.equal(option.available, true);
	assert.equal(option.account?.label, "scratch@example.invalid · Claude Max");
	assert.match(option.reason, /Claude plan usage/);

	const select = (accountSelection: string) => writeSettings({ version: 1, claudeCode: { enabled: true }, agent: { search: { engine: "claude-code", accountSelection } } });
	select(option.account!.selection);
	assert.match((await searchPickerStatus()).reason, /^Search engine: Claude Code\. Search can use your Claude plan usage limits/);
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
	const apiReason = (await searchPickerStatus()).reason;
	assert.match(apiReason, /^Search engine: Claude Code\. Claude Code is signed in with api_key/);
	assert.doesNotMatch(apiReason, /subscription/i, "a pay-per-use sign-in is never called a subscription");
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

	const fullCatalog = piModels().getProvider("xai")!.getModels().filter(({ id }) => ["grok-4.5", "grok-4.3", "grok-4.7"].includes(id));
	assert.equal(fullCatalog.length, 3);
	let catalog = fullCatalog;
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
	assert.equal(bodies[0]!.model, "grok-4.7", "the latest small Grok model is chosen even when cheaper ones are offered");
	assert.equal((bodies[0]!.reasoning as { effort?: string }).effort, "low");
	assert.deepEqual(bodies[0]!.tools, [{ type: "web_search" }]);
	assert.equal(bodies[0]!.tool_choice, "required");

	status = 403;
	await assert.rejects(searchProvider()!.search("query", 5), /Provider response: .*not included in this plan/);
	assert.equal(bodies.length, 2, "a refusal is reported without a retry");
	assert.equal(leases, 2);
	catalog = fullCatalog.filter(({ id }) => id !== "grok-4.7");
	xai.revision++;
	await assert.rejects(searchProvider()!.search("query", 5), /needs grok-4\.7, which this Grok connection does not offer/);
	assert.equal(bodies.length, 2, "no other Grok model is tried");
	catalog = fullCatalog;
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
