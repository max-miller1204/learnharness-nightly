#!/usr/bin/env node
/**
 * fake-model.mjs: a scripted OpenAI-compatible model server for prove runs.
 *
 *   node fake-model.mjs --port <n> --scenario <file.json> --log <requests.jsonl> [--fail <mode>]
 *
 * GET  /v1/models            lists the scenario's model ids.
 * POST /v1/chat/completions  answers from the first scenario rule whose
 *                            `match` fits the request (streamed or not).
 * GET  /__prove/state        { requests, fail } for scripts.
 * POST /__prove/reset        forgets which `times`-limited rules fired (call
 *                            before each drive of a scenario).
 * POST /__prove/fail?mode=   flips the fail switch at run time:
 *                            none | http500 | broken-stream | hang.
 *
 * Every chat request is appended to --log as one JSON line, with the rule it
 * matched, so a checker can see exactly what the app sent the model (system
 * prompt, tool results) and what it got back.
 *
 * Scenario file:
 * {
 *   "models": ["prove-strong", "prove-cheap", "prove-vision"],
 *   "rules": [
 *     { "id": "…", "match": { "lastRole": "tool", "lastIncludes": "…", "anyIncludes": "…",
 *                              "systemIncludes": "…", "hasTool": "read", "model": "…" },
 *       "reply": { "text": "…" } | { "toolCalls": [{ "name": "read", "arguments": { … } }] },
 *       "times": 1 }
 *   ],
 *   "fallback": { "text": "…" }
 * }
 * Rules are tried in order; `times` limits how often a rule may fire.
 * `{{lastText}}` in a reply text is replaced with the first 200 characters
 * of the last message's text, so a reply can echo a tool result back.
 */
import * as fs from "node:fs";
import * as http from "node:http";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const port = Number(opt("port", "0"));
const scenarioPath = opt("scenario");
const logPath = opt("log");
let failMode = opt("fail", "none");
if (!scenarioPath || !logPath) {
	console.error("usage: fake-model.mjs --port <n> --scenario <file.json> --log <requests.jsonl> [--fail none|http500|broken-stream|hang]");
	process.exit(2);
}
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const models = scenario.models ?? ["prove-strong", "prove-cheap", "prove-vision"];
const fired = new Map();
let requests = 0;

function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n");
	return "";
}

function matches(rule, body) {
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
	if (rule.times !== undefined && (fired.get(rule.id) ?? 0) >= rule.times) return false;
	return true;
}

function pick(body) {
	for (const rule of scenario.rules ?? []) {
		if (matches(rule, body)) {
			fired.set(rule.id, (fired.get(rule.id) ?? 0) + 1);
			return { id: rule.id, reply: rule.reply };
		}
	}
	return { id: "fallback", reply: scenario.fallback ?? { text: "zz-prove-it fallback reply." } };
}

/** `{{env:NAME}}` in any reply string becomes that environment variable (per-run fixture paths). */
function fillEnv(value) {
	if (typeof value === "string") return value.replace(/\{\{env:([A-Z0-9_]+)\}\}/g, (_, name) => process.env[name] ?? "");
	if (Array.isArray(value)) return value.map(fillEnv);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillEnv(v)]));
	return value;
}

function render(reply, body) {
	const last = (body.messages ?? []).at(-1);
	const lastText = textOf(last?.content).slice(0, 200);
	if (reply.text !== undefined) return { text: fillEnv(String(reply.text)).replaceAll("{{lastText}}", lastText) };
	return {
		toolCalls: (reply.toolCalls ?? []).map((call, i) => ({
			id: `call_prove_${requests}_${i}`,
			type: "function",
			function: { name: call.name, arguments: JSON.stringify(fillEnv(call.arguments ?? {})) },
		})),
	};
}

function chunk(model, delta, finish = null) {
	return { id: `chatcmpl-prove-${requests}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] };
}

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (req.method === "GET" && url.pathname === "/__prove/state") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ requests, fail: failMode }));
		return;
	}
	if (req.method === "POST" && url.pathname === "/__prove/reset") {
		fired.clear();
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ reset: true }));
		return;
	}
	if (req.method === "POST" && url.pathname === "/__prove/fail") {
		failMode = url.searchParams.get("mode") ?? "none";
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ fail: failMode }));
		return;
	}
	if (req.method === "GET" && url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "zz-prove-it" })) }));
		return;
	}
	if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
		let raw = "";
		req.on("data", (d) => { raw += d; });
		req.on("end", () => {
			requests++;
			let body = {};
			try { body = JSON.parse(raw); } catch { /* logged as-is below */ }
			const { id, reply } = pick(body);
			const out = render(reply, body);
			fs.appendFileSync(logPath, `${JSON.stringify({ n: requests, at: new Date().toISOString(), rule: id, fail: failMode, request: body, reply: out })}\n`);
			if (failMode === "http500") {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "zz-prove-it injected failure", type: "server_error" } }));
				return;
			}
			if (failMode === "hang") return; // never answers; the app must time out or let the user stop
			const model = body.model ?? models[0];
			if (!body.stream) {
				const message = out.text !== undefined ? { role: "assistant", content: out.text } : { role: "assistant", content: null, tool_calls: out.toolCalls };
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ id: `chatcmpl-prove-${requests}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: out.text !== undefined ? "stop" : "tool_calls" }], usage }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
			send(chunk(model, { role: "assistant", content: "" }));
			if (failMode === "broken-stream") {
				res.write("data: {not json\n\n");
				res.destroy();
				return;
			}
			if (out.text !== undefined) {
				for (const piece of out.text.match(/.{1,40}/gs) ?? [""]) send(chunk(model, { content: piece }));
				send(chunk(model, {}, "stop"));
			} else {
				out.toolCalls.forEach((call, index) => {
					send(chunk(model, { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }));
					send(chunk(model, { tool_calls: [{ index, function: { arguments: call.function.arguments } }] }));
				});
				send(chunk(model, {}, "tool_calls"));
			}
			send({ ...chunk(model, {}), choices: [], usage });
			res.write("data: [DONE]\n\n");
			res.end();
		});
		return;
	}
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message: `fake-model: no route ${req.method} ${url.pathname}` } }));
});

server.listen(port, "127.0.0.1", () => {
	const address = server.address();
	console.log(`FAKE_MODEL_LISTENING ${typeof address === "object" && address ? address.port : port}`);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
