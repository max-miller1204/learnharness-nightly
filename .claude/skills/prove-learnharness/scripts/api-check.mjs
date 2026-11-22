#!/usr/bin/env node
/**
 * api-check.mjs <instance.env>
 *
 * The HTTP API (app/api) as a non-browser client sees it, against one
 * instance from start.sh:
 *   - read routes: status plus the SHAPE of each body (keys and value types,
 *     not values), so base and head can be diffed without timestamps or ids,
 *   - refusals: a foreign Host, a cross-site Origin, cross-site fetch
 *     metadata, a wrong method, an unknown id, bad JSON, empty input,
 *   - a lifecycle round trip: create a session, see it in the list and on
 *     disk, delete it, see it gone from both,
 *   - a model failure: with the fake model failing (http500), a turn must
 *     end with an error recorded, never a fake success.
 * Writes <side dir>/api-check/result.json in web-teach.mjs's format, so
 * compare.mjs diffs it the same way.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const instPath = process.argv[2];
if (!instPath) { console.error("usage: api-check.mjs <instance.env>"); process.exit(2); }
const inst = Object.fromEntries(fs.readFileSync(instPath, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
	const i = l.indexOf("=");
	return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
}));
const OUT = path.join(path.dirname(instPath), "api-check");
fs.mkdirSync(OUT, { recursive: true });
import { authHeaders, signIn } from "./sign-in.mjs";
signIn(inst);
const APP = inst.APP_URL;
const turnMs = Number(process.env.TURN_TIMEOUT_S || 60) * 1000;
const steps = [];
const result = { side: inst.SIDE, app: APP, build: inst.BUILD_STAMP, startedAt: new Date().toISOString(), steps, observations: { readShapes: [], refusals: [], lifecycle: [], modelFailure: [] }, budgets: {} };
const save = () => fs.writeFileSync(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
const step = (name, ok, note) => { steps.push({ name, ok, note }); save(); console.log(`[${ok ? "ok" : "FAIL"}] ${name}${note ? `: ${note}` : ""}`); };

/** Keys and types, recursively; arrays collapse to the union of their items' shapes. */
function shape(value, depth = 0) {
	if (depth > 6) return "…";
	if (value === null) return "null";
	if (Array.isArray(value)) {
		const items = [...new Set(value.map((v) => JSON.stringify(shape(v, depth + 1))))].sort();
		return items.length ? `[${items.join("|")}]` : "[]";
	}
	if (typeof value === "object") {
		// Map-like objects keyed by ids/dates collapse to <key>.
		const keys = Object.keys(value).sort();
		const idLike = keys.length > 0 && keys.every((k) => /^(chat|job|node|src|th)_|^[0-9a-f-]{16,}$|^\d{4}-\d{2}/.test(k));
		if (idLike) return { "<key>": [...new Set(keys.map((k) => JSON.stringify(shape(value[k], depth + 1))))].sort() };
		return Object.fromEntries(keys.map((k) => [k, shape(value[k], depth + 1)]));
	}
	return typeof value;
}

/** Raw request, so the Host header can be forged (fetch won't let us). */
function raw(method, pathname, { headers = {}, body, signedOut = false } = {}) {
	return new Promise((resolve, reject) => {
		const url = new URL(pathname, APP);
		const req = http.request({ host: url.hostname, port: url.port, method, path: url.pathname + url.search, headers: { ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}), ...(signedOut ? {} : authHeaders(inst)), ...headers } }, (res) => {
			let data = "";
			res.on("data", (d) => { data += d; });
			res.on("end", () => resolve({ status: res.statusCode, body: data }));
		});
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

// [route, extra headers, expected status]. Claude Code is off by default, so its
// status check answers 403 "disabled" until the user opts in.
const READS = [
	["/api/health"], ["/api/settings"], ["/api/models"], ["/api/chats"], ["/api/graph"], ["/api/graph/status"],
	["/api/graph/costs"], ["/api/graph/sources"], ["/api/plugins"], ["/api/themes"], ["/api/activity"], ["/api/updates"],
	["/api/keys"], ["/api/custom-provider"], ["/api/settings/prompts"],
	["/api/subscriptions", { "x-learnharness-subscriptions": "1" }],
	["/api/claude-code", { "x-learnharness-claude-code": "1" }, 403],
];
try {
	for (const [route, extra = {}, want = 200] of READS) {
		// Same-origin, as the app's own pages call them (some routes require it).
		const r = await raw("GET", route, { headers: { origin: APP, ...extra } });
		let parsed;
		try { parsed = JSON.parse(r.body); } catch { parsed = `non-JSON ${r.body.length} bytes`; }
		result.observations.readShapes.push(`GET ${route} ${r.status} ${JSON.stringify(shape(parsed))}`);
		if (r.status !== want) step(`GET ${route}`, false, `status ${r.status} (want ${want}): ${r.body.slice(0, 200)}`);
	}
	step("read routes answer with their expected status", READS.every(([route, , want = 200]) => result.observations.readShapes.some((s) => s.startsWith(`GET ${route} ${want} `))), `${READS.length} routes`);

	// A build with login (docs/specs/login-pairing.md) replaces the Host and
	// cross-site checks with a credential and the cookie rule: Fetch Metadata
	// first; without it an Origin must name the host, and with no Origin a
	// cookie request to /api needs a Referer naming the host (issue #323).
	// The Host and Referer probes send no Fetch Metadata, like a plain-HTTP
	// browser; the cross-site probes send `sec-fetch-site: cross-site`.
	const cookie = inst.APP_TOKEN ? { cookie: `lh_session_${inst.APP_PORT}=${inst.APP_TOKEN}` } : {};
	const refusals = inst.APP_TOKEN ? [
		["no credential is 401", "GET", "/api/settings", { signedOut: true }, 401],
		["no credential on a page shows the pairing screen", "GET", "/chat/new", { signedOut: true }, 200],
		["a forged bearer token is 401", "GET", "/api/settings", { signedOut: true, headers: { authorization: "Bearer forged.token" } }, 401],
		// No Host allowlist: a page served under any host name works, with its own Referer.
		["foreign Host is allowed with a login", "GET", "/api/settings", { signedOut: true, headers: { host: "evil.example", referer: "http://evil.example/", ...cookie } }, 200],
		["a cookie API read with no Origin and no Referer is refused", "GET", "/api/settings", { signedOut: true, headers: { host: "evil.example", ...cookie } }, 403, "This request needs a Referer from this server"],
		["cross-site Origin write with a cookie is refused", "POST", "/api/chats", { signedOut: true, headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site", ...cookie }, body: "{}" }, 403],
		// Issue #303: fetch metadata only, no Origin. A build that accepts it
		// creates a session, which the loop below deletes again.
		["cross-site fetch metadata write with a cookie is refused", "POST", "/api/chats", { signedOut: true, headers: { "sec-fetch-site": "cross-site", ...cookie }, body: JSON.stringify({ title: "zz-prove-it cross-site" }) }, 403],
	] : [
		["foreign Host is refused", "GET", "/api/health", { headers: { host: "evil.example" } }, 403],
		["cross-site Origin write is refused", "POST", "/api/chats", { headers: { origin: "http://evil.example" }, body: "{}" }, 403],
		["cross-site fetch metadata write is refused", "POST", "/api/chats", { headers: { "sec-fetch-site": "cross-site" }, body: "{}" }, 403],
	];
	refusals.push(
		["unknown session is 404", "GET", "/api/chats/chat_zzproveit_00000000", {}, 404],
		["turn on unknown session is 404", "POST", "/api/chat", { body: JSON.stringify({ chatId: "chat_zzproveit_00000000", input: { type: "text", text: "zz-prove-it" } }) }, 404],
		["turn with bad JSON is 400", "POST", "/api/chat", { body: "{not json" }, 400],
		["delete without a mode is 400", "DELETE", "/api/chats/chat_zzproveit_00000000", {}, 400],
	);
	// [name, method, route, options, status, text the body must contain]
	for (const [name, method, route, opts, want, bodyHas] of refusals) {
		const r = await raw(method, route, opts);
		if (method === "POST" && route === "/api/chats" && r.status === 200) {
			let id;
			try { id = JSON.parse(r.body).id; } catch { /* not a created session */ }
			if (typeof id === "string") {
				const cleanup = await raw("DELETE", `/api/chats/${encodeURIComponent(id)}?mode=preserve-graph`).catch((error) => ({ status: 0, body: String(error) }));
				if (cleanup.status !== 200) step(`cleanup after "${name}"`, false, `DELETE ${id} -> ${cleanup.status}: zz-prove-it session left on disk at ${path.join(inst.DATA_DIR, "chats", `${id}.json`)}`);
			}
		}
		result.observations.refusals.push(`${name}: ${r.status}`);
		step(name, r.status === want && (bodyHas === undefined || r.body.includes(bodyHas)), `${method} ${route} -> ${r.status} (want ${want}${bodyHas === undefined ? "" : `, body with "${bodyHas}"`}) ${r.body.slice(0, 120)}`);
	}
	const empty = await (async () => {
		const c = JSON.parse((await raw("POST", "/api/chats", { body: JSON.stringify({ title: "zz-prove-it empty input" }) })).body);
		const r = await raw("POST", "/api/chat", { body: JSON.stringify({ chatId: c.id, input: { type: "text", text: "   " } }) });
		await raw("DELETE", `/api/chats/${c.id}?mode=preserve-graph`);
		return r;
	})();
	result.observations.refusals.push(`empty text input: ${empty.status}`);
	step("empty text input is 400", empty.status === 400, `${empty.status} ${empty.body.slice(0, 120)}`);

	// lifecycle round trip
	const created = await raw("POST", "/api/chats", { body: JSON.stringify({ title: "zz-prove-it lifecycle" }) });
	const chat = JSON.parse(created.body);
	const file = path.join(inst.DATA_DIR, "chats", `${chat.id}.json`);
	const listed = JSON.parse((await raw("GET", "/api/chats")).body).chats.some((c) => c.id === chat.id);
	const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
	step("created session is listed and stored with its title and the strong-slot model", created.status === 200 && listed && stored?.title === "zz-prove-it lifecycle", `POST ${created.status}, listed ${listed}, title ${stored?.title}, model ${JSON.stringify(stored?.settings?.model ?? null)}`);
	const del = await raw("DELETE", `/api/chats/${chat.id}?mode=preserve-graph`);
	const stillListed = JSON.parse((await raw("GET", "/api/chats")).body).chats.some((c) => c.id === chat.id);
	step("deleted session leaves the list and the disk", del.status === 200 && !stillListed && !fs.existsSync(file), `DELETE ${del.status}, listed ${stillListed}, file ${fs.existsSync(file) ? "still there" : "gone"}`);
	result.observations.lifecycle.push(`create ${created.status}`, `listed ${listed}`, `stored ${Boolean(stored)}`, `delete ${del.status}`, `listed after ${stillListed}`, `file after ${fs.existsSync(file)}`);

	// list order: one session hides it, so make three, a moment apart, and read
	// the list's order back by label (ids differ between base and head)
	const labels = ["first", "second", "third"];
	const made = [];
	for (const label of labels) {
		const r = await raw("POST", "/api/chats", { body: JSON.stringify({ title: `zz-prove-it order ${label}` }) });
		made.push({ label, id: r.status === 200 ? JSON.parse(r.body).id : null });
		await new Promise((res) => setTimeout(res, 50));
	}
	const labelsOf = async () => JSON.parse((await raw("GET", "/api/chats")).body).chats.map((c) => made.find((m) => m.id === c.id)?.label).filter(Boolean);
	const listedOrder = await labelsOf();
	// A turn on the first one: ordering by last activity (first, third, second)
	// now differs from ordering by creation (third, second, first).
	const touch = await raw("POST", "/api/chat", { body: JSON.stringify({ chatId: made[0].id, input: { type: "text", text: "list order touch" } }) });
	// The POST only acknowledges the turn: read the order, and delete, once it settled.
	const busyOf = async (id) => JSON.parse((await raw("GET", "/api/chats")).body).chats.find((c) => c.id === id)?.busy;
	const settleBy = Date.now() + turnMs;
	while (Date.now() < settleBy && (await busyOf(made[0].id)) !== false) await new Promise((res) => setTimeout(res, 250));
	const touchedOrder = await labelsOf();
	const leftover = [];
	for (const m of made) {
		if (!m.id) continue;
		let status = 0;
		for (let attempt = 0; attempt < 20; attempt++) {
			status = (await raw("DELETE", `/api/chats/${m.id}?mode=preserve-graph`)).status;
			if (status !== 409) break; // a turn still running: try again shortly
			await new Promise((res) => setTimeout(res, 500));
		}
		if (status !== 200) leftover.push(`${m.label} (${status})`);
	}
	step("the list-order fixture sessions are deleted", leftover.length === 0, leftover.length ? `left behind: ${leftover.join(", ")}` : "all three gone");
	result.observations.listOrder = [`created: ${listedOrder.join(",")}`, `after a turn on first: ${touchedOrder.join(",")}`];
	step("the session list is newest first, by last activity", JSON.stringify(listedOrder) === JSON.stringify(["third", "second", "first"]) && touch.status === 200 && JSON.stringify(touchedOrder) === JSON.stringify(["first", "third", "second"]), `created ${JSON.stringify(listedOrder)}, turn ${touch.status}, then ${JSON.stringify(touchedOrder)}`);

	// model failure is reported, not swallowed
	await fetch(`${inst.FAKE_CONTROL}/__prove/fail?mode=http500`, { method: "POST" });
	try {
		const c = JSON.parse((await raw("POST", "/api/chats", { body: JSON.stringify({ title: "zz-prove-it model failure" }) })).body);
		const turn = await raw("POST", "/api/chat", { body: JSON.stringify({ chatId: c.id, input: { type: "text", text: "zz-prove-it model failure" } }) });
		const deadline = Date.now() + turnMs;
		let record;
		while (Date.now() < deadline) {
			const r = await raw("GET", "/api/chats");
			const busy = JSON.parse(r.body).chats.find((x) => x.id === c.id)?.busy;
			record = JSON.parse(fs.readFileSync(path.join(inst.DATA_DIR, "chats", `${c.id}.json`), "utf8"));
			if (!busy && (record.messages ?? []).some((m) => m.role === "assistant")) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		const last = (record?.messages ?? []).filter((m) => m.role === "assistant").at(-1);
		const errorText = JSON.stringify(last ?? {});
		const reported = last?.stopReason === "error" || /error|500|injected failure/i.test(last?.errorMessage ?? "");
		step("a failing model ends the turn with a recorded error", turn.status === 200 && reported, `turn POST ${turn.status}, last assistant stopReason ${last?.stopReason}, errorMessage ${(last?.errorMessage ?? "").slice(0, 160)}`);
		result.observations.modelFailure.push(`turn ${turn.status}`, `stopReason ${last?.stopReason ?? "none"}`, `reported ${reported}`);
		fs.writeFileSync(path.join(OUT, "model-failure-last-message.json"), errorText);
		await raw("DELETE", `/api/chats/${c.id}?mode=preserve-graph`);
	} finally {
		await fetch(`${inst.FAKE_CONTROL}/__prove/fail?mode=none`, { method: "POST" });
	}
} catch (error) {
	step("api check", false, String(error?.stack ?? error).slice(0, 800));
}
result.finishedAt = new Date().toISOString();
save();
console.log(`result: ${path.join(OUT, "result.json")}`);
process.exit(steps.every((s) => s.ok) ? 0 : 1);
