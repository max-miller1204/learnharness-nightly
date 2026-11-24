/**
 * A scripted OpenAI-compatible model server for e2e runs, so a teaching
 * session runs with no provider key and the same replies every time.
 *
 * GET  /v1/models            lists the scenario's model ids.
 * POST /v1/chat/completions  answers from the first scenario rule whose
 *                            `match` fits the request (streamed or not).
 * GET  /__fake/state         { requests, fail }.
 * POST /__fake/reset         forgets which `times`-limited rules fired.
 * POST /__fake/fail?mode=    none | http500 | broken-stream | hang.
 *
 * Every chat request is appended to the log as one JSON line with the rule it
 * matched, so a test can read exactly what the app sent the model (system
 * prompt, tool results) and what it got back.
 *
 * Scenario file:
 * {
 *   "models": ["e2e-strong", "e2e-cheap", "e2e-vision"],
 *   "rules": [
 *     { "id": "…", "match": { "lastRole": "tool", "lastIncludes": "…", "anyIncludes": "…",
 *                              "systemIncludes": "…", "hasTool": "read", "noTool": "…", "model": "…" },
 *       "reply": { "text": "…" } | { "toolCalls": [{ "name": "read", "arguments": { … } }] },
 *       "times": 1 }
 *   ],
 *   "fallback": { "text": "…" }
 * }
 * A reply may also carry `delayMs` (hold the whole reply back) and
 * `pauseBeforeDoneMs` (hold the end of the stream). Rules are tried in order;
 * `times` limits how often a rule may fire in one session (requests that
 * share their first user message), so tests running side by side don't use
 * up each other's rules. In reply strings, `{{var:NAME}}`
 * is a value the launcher passes (fixture paths), `{{lastText}}` the first 200
 * characters of the last message's text, and `{{attachmentRef}}` the first
 * `attachment:<id>` the app sent.
 */
import * as fs from "node:fs";
import * as http from "node:http";

type Content = string | Array<string | { text?: string }> | null | undefined;
type Message = { role?: string; content?: Content };
type Body = { model?: string; stream?: boolean; messages?: Message[]; tools?: Array<{ name?: string; function?: { name?: string } }> };
type Reply = { text?: string; toolCalls?: Array<{ name: string; arguments?: unknown }>; delayMs?: number; pauseBeforeDoneMs?: number };
type Rule = { id: string; match?: Record<string, string>; reply: Reply; times?: number };
type Scenario = { models?: string[]; rules?: Rule[]; fallback?: Reply };
export type FailMode = "none" | "http500" | "broken-stream" | "hang";

const textOf = (content: Content): string => {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n");
	return "";
};

export async function startFakeModel(options: { scenario: string; log: string; vars?: Record<string, string> }): Promise<{ url: string; control: string; close: () => Promise<void> }> {
	const scenario = JSON.parse(fs.readFileSync(options.scenario, "utf8")) as Scenario;
	const models = scenario.models ?? ["e2e-strong", "e2e-cheap", "e2e-vision"];
	const vars = options.vars ?? {};
	const fired = new Map<string, number>();
	let requests = 0;
	let failMode: FailMode = "none";

	const matches = (rule: Rule, body: Body) => {
		const m = rule.match ?? {};
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const last = messages.at(-1) ?? {};
		const system = messages.filter((x) => x.role === "system" || x.role === "developer").map((x) => textOf(x.content)).join("\n");
		const all = messages.map((x) => textOf(x.content)).join("\n");
		const tools = (body.tools ?? []).map((t) => t?.function?.name ?? t?.name);
		if (m.model && body.model !== m.model) return false;
		if (m.lastRole && last.role !== m.lastRole) return false;
		if (m.lastIncludes && !textOf(last.content).includes(m.lastIncludes)) return false;
		if (m.anyIncludes && !all.includes(m.anyIncludes)) return false;
		if (m.systemIncludes && !system.includes(m.systemIncludes)) return false;
		if (m.hasTool && !tools.includes(m.hasTool)) return false;
		if (m.noTool && tools.includes(m.noTool)) return false;
		return rule.times === undefined || (fired.get(firedKey(rule, body)) ?? 0) < rule.times;
	};
	const firedKey = (rule: Rule, body: Body) => `${textOf((body.messages ?? []).find((x) => x.role === "user")?.content)}\u0000${rule.id}`;
	const pick = (body: Body): { id: string; reply: Reply } => {
		for (const rule of scenario.rules ?? []) {
			if (!matches(rule, body)) continue;
			fired.set(firedKey(rule, body), (fired.get(firedKey(rule, body)) ?? 0) + 1);
			return { id: rule.id, reply: rule.reply };
		}
		return { id: "fallback", reply: scenario.fallback ?? { text: "zz-e2e fallback reply." } };
	};
	const fill = (value: unknown, attachmentRef: string): unknown => {
		if (typeof value === "string") return value.replace(/\{\{var:([A-Za-z0-9_]+)\}\}/g, (_, name: string) => vars[name] ?? "").replaceAll("{{attachmentRef}}", attachmentRef);
		if (Array.isArray(value)) return value.map((item) => fill(item, attachmentRef));
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, attachmentRef)]));
		return value;
	};
	const render = (reply: Reply, body: Body) => {
		const messages = body.messages ?? [];
		const lastText = textOf(messages.at(-1)?.content).slice(0, 200);
		const attachmentRef = messages.map((x) => textOf(x.content)).join("\n").match(/attachment:[0-9a-f-]{36}/)?.[0] ?? "";
		if (reply.text !== undefined) return { text: String(fill(reply.text, attachmentRef)).replaceAll("{{lastText}}", lastText) };
		return {
			toolCalls: (reply.toolCalls ?? []).map((call, i) => ({
				id: `call_e2e_${requests}_${i}`,
				type: "function",
				function: { name: call.name, arguments: JSON.stringify(fill(call.arguments ?? {}, attachmentRef)) },
			})),
		};
	};
	const chunk = (model: string, delta: object, finish: string | null = null) =>
		({ id: `chatcmpl-e2e-${requests}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] });
	const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
	const json = (res: http.ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method === "GET" && url.pathname === "/__fake/state") return json(res, 200, { requests, fail: failMode });
		if (req.method === "POST" && url.pathname === "/__fake/reset") {
			fired.clear();
			return json(res, 200, { reset: true });
		}
		if (req.method === "POST" && url.pathname === "/__fake/fail") {
			failMode = (url.searchParams.get("mode") ?? "none") as FailMode;
			return json(res, 200, { fail: failMode });
		}
		if (req.method === "GET" && url.pathname.endsWith("/models")) {
			return json(res, 200, { object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "zz-e2e" })) });
		}
		if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
			return json(res, 404, { error: { message: `fake-model: no route ${req.method} ${url.pathname}` } });
		}
		let raw = "";
		req.on("data", (d) => { raw += d; });
		req.on("end", () => {
			requests++;
			let body: Body = {};
			try { body = JSON.parse(raw) as Body; } catch { /* logged as-is below */ }
			const { id, reply } = pick(body);
			const out = render(reply, body);
			fs.appendFileSync(options.log, `${JSON.stringify({ n: requests, at: new Date().toISOString(), rule: id, fail: failMode, request: body, reply: out })}\n`);
			if (failMode === "http500") return json(res, 500, { error: { message: "zz-e2e injected failure", type: "server_error" } });
			if (failMode === "hang") return; // never answers; the app must time out or let the user stop
			const model = body.model ?? models[0] ?? "e2e-strong";
			const done = out.text !== undefined ? "stop" : "tool_calls";
			if (!body.stream) {
				const message = out.text !== undefined ? { role: "assistant", content: out.text } : { role: "assistant", content: null, tool_calls: out.toolCalls };
				return json(res, 200, { id: `chatcmpl-e2e-${requests}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: done }], usage });
			}
			const stream = () => {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
				const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
				send(chunk(model, { role: "assistant", content: "" }));
				if (failMode === "broken-stream") {
					res.write("data: {not json\n\n");
					res.destroy();
					return;
				}
				if (out.text !== undefined) {
					for (const piece of out.text.match(/.{1,40}/gs) ?? [""]) send(chunk(model, { content: piece }));
				} else {
					out.toolCalls?.forEach((call, index) => {
						send(chunk(model, { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }));
						send(chunk(model, { tool_calls: [{ index, function: { arguments: call.function.arguments } }] }));
					});
				}
				const finish = () => {
					if (res.destroyed) return;
					send(chunk(model, {}, done));
					send({ ...chunk(model, {}), choices: [], usage });
					res.write("data: [DONE]\n\n");
					res.end();
				};
				if (Number.isSafeInteger(reply.pauseBeforeDoneMs) && reply.pauseBeforeDoneMs! > 0) {
					const pause = setTimeout(finish, reply.pauseBeforeDoneMs);
					res.once("close", () => clearTimeout(pause));
				} else finish();
			};
			if (Number.isSafeInteger(reply.delayMs) && reply.delayMs! > 0) {
				const delay = setTimeout(() => { if (!res.destroyed) stream(); }, reply.delayMs);
				res.once("close", () => clearTimeout(delay));
			} else stream();
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}/v1`,
		control: `http://127.0.0.1:${port}`,
		close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
	};
}
