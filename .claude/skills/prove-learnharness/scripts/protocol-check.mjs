// protocol-check.mjs <instance.env> [out dir] : drives the client protocol
// (docs/specs/client-protocol.md) against one instance and records raw
// observations in <out dir>/result.json: server info, the version check
// matrix, and a native client end to end. It judges nothing: compare the
// observations with the spec.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";

const [envFile, outArg] = process.argv.slice(2);
// The worktree this skill lives in (its auth-store mints the pairing code).
const repo = path.resolve(import.meta.dirname, "../../../..");
const outDir = outArg ?? path.join(path.dirname(envFile), "protocol");
const env = Object.fromEntries(fs.readFileSync(envFile, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^'|'$/g, "").replace(/^"|"$/g, "")]; }));
const URL0 = env.APP_URL;
const PORT = new URL(URL0).port;
fs.mkdirSync(outDir, { recursive: true });
const log = [];
const note = (step, data) => { log.push({ step, ...data }); console.log(JSON.stringify({ step, ...data }).slice(0, 600)); };

// raw http so headers are sent exactly (empty value, spaces) and nothing is added
function raw(method, p, headers = {}, body) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let json; try { json = JSON.parse(text); } catch {}
				resolve({ status: res.statusCode, headers: res.headers, text: json ? undefined : text.slice(0, 300), json });
			});
		});
		req.on("error", reject);
		req.setTimeout(15000, () => req.destroy(new Error("timeout " + p)));
		if (body) req.write(body);
		req.end();
	});
}
// read an SSE stream for up to ms, return frames; stop early on [DONE] when untilDone
function sse(p, headers, { ms = 20000, untilDone = false, onOpen } = {}) {
	return new Promise((resolve) => {
		const frames = []; let buf = ""; let status, resHeaders;
		const req = http.request({ host: "127.0.0.1", port: PORT, method: "GET", path: p, headers: { accept: "text/event-stream", ...headers } }, (res) => {
			status = res.statusCode; resHeaders = res.headers;
			onOpen?.();
			res.setEncoding("utf8");
			res.on("data", (c) => {
				buf += c;
				let i;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const block = buf.slice(0, i); buf = buf.slice(i + 2);
					const f = {};
					for (const line of block.split("\n")) {
						if (line.startsWith(":")) f.comment = line.slice(1).trim();
						else if (line.startsWith("event:")) f.event = line.slice(6).trim();
						else if (line.startsWith("data:")) f.data = (f.data ?? "") + line.slice(5).trim();
					}
					frames.push(f);
					if (untilDone && f.data === "[DONE]") { req.destroy(); return resolve({ status, headers: resHeaders, frames, done: true }); }
				}
			});
			res.on("end", () => resolve({ status, headers: resHeaders, frames, ended: true, rest: buf.slice(0, 300) }));
		});
		req.on("error", () => resolve({ status, headers: resHeaders, frames, aborted: true }));
		setTimeout(() => { req.destroy(); resolve({ status, headers: resHeaders, frames, timedOut: true }); }, ms);
		req.end();
	});
}
const keys = (o) => (o && typeof o === "object" ? Object.keys(o).sort() : typeof o);
const pick = (r) => ({ status: r.status, ctype: r.headers["content-type"], cache: r.headers["cache-control"], body: r.json ?? r.text });

const results = { env: { APP_URL: URL0, DATA_DIR: env.DATA_DIR, hostname: os.hostname() } };
const auth = env.APP_TOKEN ? { authorization: `Bearer ${env.APP_TOKEN}` } : {};

// ── a. server info ──────────────────────────────────────────────────────────
const SI = "/.well-known/learnharness/server";
{
	const r = await raw("GET", SI);
	results.serverInfo = { status: r.status, headers: r.headers, body: r.json ?? r.text };
	const health = await raw("GET", "/api/health");
	results.health = health.json;
	note("a.server-info", pick(r));
	const variants = {
		header2: { "x-learnharness-protocol": "2" },
		header1: { "x-learnharness-protocol": "1" },
		headerGarbage: { "x-learnharness-protocol": "abc" },
		badBearer: { authorization: "Bearer nope" },
		crossSiteCookie: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
	};
	results.serverInfoVariants = {};
	for (const [k, h] of Object.entries(variants)) results.serverInfoVariants[k] = pick(await raw("GET", SI, h));
	results.serverInfoVariants.query2 = pick(await raw("GET", SI + "?protocol=2"));
	results.serverInfoVariants.trailingSlash = pick(await raw("GET", SI + "/"));
	results.serverInfoVariants.head = (await raw("HEAD", SI)).status;
	results.serverInfoVariants.post = pick(await raw("POST", SI, { "content-type": "application/json" }, "{}"));
	note("a.server-info-variants", results.serverInfoVariants);
}

// ── b. version check matrix ─────────────────────────────────────────────────
{
	const routes = [
		["GET", "/api/health", "public"],
		["GET", "/api/auth/session", "public"],
		["GET", "/pair", "public page"],
		["POST", "/oauth/token", "public"],
		["GET", "/api/chats", "signed-in api"],
		["GET", "/", "signed-in page"],
		["GET", "/chat/new", "signed-in page"],
	];
	const variants = {
		none: {},
		"header=1": { "x-learnharness-protocol": "1" },
		"header=2": { "x-learnharness-protocol": "2" },
		"header=0": { "x-learnharness-protocol": "0" },
		"header=1.0": { "x-learnharness-protocol": "1.0" },
		"header=' 1 '": { "x-learnharness-protocol": " 1 " },
		"header=''": { "x-learnharness-protocol": "" },
	};
	results.matrix = [];
	for (const [method, p, kind] of routes) {
		for (const cred of ["out", "in"]) {
			for (const [vn, h] of Object.entries(variants)) {
				const headers = { ...h, ...(cred === "in" ? auth : {}) };
				let body;
				if (method === "POST") { headers["content-type"] = "application/x-www-form-urlencoded"; body = "grant_type=x"; }
				const r = await raw(method, p, headers, body);
				results.matrix.push({ method, path: p, kind, cred, variant: vn, status: r.status, cache: r.headers["cache-control"], body: r.json ?? (r.text ? r.text.slice(0, 80) : "") });
			}
			// query variants
			for (const q of ["protocol=2", "protocol=1"]) {
				const headers = { ...(cred === "in" ? auth : {}) };
				let body;
				if (method === "POST") { headers["content-type"] = "application/x-www-form-urlencoded"; body = "grant_type=x"; }
				const r = await raw(method, `${p}?${q}`, headers, body);
				results.matrix.push({ method, path: p, kind, cred, variant: `query ${q}`, status: r.status, body: r.json ?? (r.text ? r.text.slice(0, 80) : "") });
			}
			// header and query disagree
			for (const [hv, q] of [["1", "2"], ["2", "1"]]) {
				const headers = { "x-learnharness-protocol": hv, ...(cred === "in" ? auth : {}) };
				let body;
				if (method === "POST") { headers["content-type"] = "application/x-www-form-urlencoded"; body = "grant_type=x"; }
				const r = await raw(method, `${p}?protocol=${q}`, headers, body);
				results.matrix.push({ method, path: p, kind, cred, variant: `header=${hv} query=${q}`, status: r.status, body: r.json ?? (r.text ? r.text.slice(0, 80) : "") });
			}
		}
	}
	// streams with ?protocol=2 (and header) signed in and out: status only, short read
	results.streams = [];
	for (const [p, label] of [["/api/events", "events"], ["/api/chats/chat_zz_prove_missing/stream", "turn stream (unknown id)"]]) {
		for (const cred of ["out", "in"]) {
			for (const [vn, q, h] of [["query 2", "?protocol=2", {}], ["query 1", "?protocol=1", {}], ["header 2", "", { "x-learnharness-protocol": "2" }], ["none", "", {}]]) {
				const r = await sse(p + q, { ...h, ...(cred === "in" ? auth : {}) }, { ms: 1500 });
				results.streams.push({ path: p, label, cred, variant: vn, status: r.status, ctype: r.headers?.["content-type"], frames: r.frames.slice(0, 3), ended: !!r.ended });
			}
		}
	}
	note("b.matrix", { rows: results.matrix.length });
}

// ── c. native client end to end ─────────────────────────────────────────────
{
	const P = { "x-learnharness-protocol": "1" };
	const store = await import(path.join(repo, "selfhost/src/auth-store.ts"));
	const link = store.createPairingLink(env.DATA_DIR, { label: "zz-prove-it native client" });
	results.pairing = { id: link.id, codeLength: link.code.length, expiresAt: link.expiresAt };
	const form = new URLSearchParams({
		grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
		subject_token: link.code,
		subject_token_type: "urn:learnharness:params:oauth:token-type:pairing-code",
		requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
		client_label: "zz-prove-it native client",
		client_device_type: "mobile",
		client_os: "Android",
	}).toString();
	const tok = await raw("POST", "/oauth/token", { ...P, "content-type": "application/x-www-form-urlencoded" }, form);
	results.token = { status: tok.status, cache: tok.headers["cache-control"], keys: keys(tok.json), token_type: tok.json?.token_type, issued_token_type: tok.json?.issued_token_type, expires_in: tok.json?.expires_in, access_token_present: typeof tok.json?.access_token === "string" };
	const reuse = await raw("POST", "/oauth/token", { ...P, "content-type": "application/x-www-form-urlencoded" }, form);
	results.tokenReuse = { status: reuse.status, body: reuse.json };
	const B = { ...P, authorization: `Bearer ${tok.json.access_token}` };
	note("c.token", results.token);

	const sess = await raw("GET", "/api/auth/session", B);
	results.session = { status: sess.status, body: sess.json };
	const sessOut = await raw("GET", "/api/auth/session", P);
	results.sessionOut = { status: sessOut.status, body: sessOut.json };

	const list0 = await raw("GET", "/api/chats", B);
	results.list0 = { status: list0.status, keys: keys(list0.json), count: list0.json?.chats?.length };
	const created = await raw("POST", "/api/chats", { ...B, "content-type": "application/json" }, JSON.stringify({ title: "zz-prove-it protocol client" }));
	results.create = { status: created.status, body: created.json };
	const chatId = created.json.id;
	const list1 = await raw("GET", "/api/chats", B);
	const row = list1.json?.chats?.find((c) => c.id === chatId);
	results.list1 = { status: list1.status, count: list1.json?.chats?.length, rowKeys: keys(row), row };
	const one = await raw("GET", `/api/chats/${chatId}`, B);
	results.open0 = { status: one.status, keys: keys(one.json), turnInFlight: one.json?.turnInFlight, messages: one.json?.messages?.length };

	// events stream open before the send
	const evP = sse("/api/events?protocol=1", { authorization: B.authorization }, { ms: 12000 });
	await new Promise((r) => setTimeout(r, 500));
	const send = await raw("POST", "/api/chat", { ...B, "content-type": "application/json" }, JSON.stringify({ chatId, input: { type: "text", text: "zz-prove-it: why is the sky blue? read my fixture file" } }));
	results.send = { status: send.status, ctype: send.headers["content-type"], body: send.json ?? send.text };
	const stream = await sse(`/api/chats/${chatId}/stream`, B, { ms: 30000, untilDone: true });
	const types = stream.frames.map((f) => { if (f.data === "[DONE]") return "[DONE]"; try { return JSON.parse(f.data).type; } catch { return "?" + (f.data ?? f.comment); } });
	results.turnStream = { status: stream.status, ctype: stream.headers?.["content-type"], done: !!stream.done, frameTypes: types, firstFrames: stream.frames.slice(0, 2).map((f) => (f.data ?? "").slice(0, 300)) };
	note("c.stream", { status: stream.status, done: stream.done, n: types.length, uniq: [...new Set(types)] });
	const ev = await evP;
	results.events = { status: ev.status, ctype: ev.headers?.["content-type"], frames: ev.frames.map((f) => ({ event: f.event, data: f.data, comment: f.comment })) };
	note("c.events", { status: ev.status, frames: results.events.frames });
	const one2 = await raw("GET", `/api/chats/${chatId}`, B);
	results.open1 = { status: one2.status, keys: keys(one2.json), turnInFlight: one2.json?.turnInFlight, messages: one2.json?.messages?.map((m) => ({ role: m.role, kinds: Array.isArray(m.content) ? m.content.map((c) => c.type + (c.name ? ":" + c.name : "")) : typeof m.content })), coverage: one2.json?.coverage, pricingKeys: keys(one2.json?.pricing) };
	const ab = await raw("POST", "/api/activity/abort", { ...B, "content-type": "application/json" }, JSON.stringify({ kind: "turn", id: chatId }));
	results.abortSettled = { status: ab.status, body: ab.json };

	// a running turn, then abort it: hang the fake model
	if (env.FAKE_CONTROL) {
		await fetch(`${env.FAKE_CONTROL}/__prove/fail?mode=hang`, { method: "POST" });
		const c2 = await raw("POST", "/api/chats", { ...B, "content-type": "application/json" }, JSON.stringify({ title: "zz-prove-it protocol abort" }));
		const id2 = c2.json.id;
		const s2 = await raw("POST", "/api/chat", { ...B, "content-type": "application/json" }, JSON.stringify({ chatId: id2, input: { type: "text", text: "zz-prove-it: hang please" } }));
		const st2P = sse(`/api/chats/${id2}/stream`, B, { ms: 20000, untilDone: true });
		await new Promise((r) => setTimeout(r, 1500));
		const during = await raw("GET", `/api/chats/${id2}`, B);
		const ab2 = await raw("POST", "/api/activity/abort", { ...B, "content-type": "application/json" }, JSON.stringify({ kind: "turn", id: id2 }));
		const st2 = await st2P;
		const after = await raw("GET", `/api/chats/${id2}`, B);
		await fetch(`${env.FAKE_CONTROL}/__prove/fail?mode=none`, { method: "POST" });
		results.abortRunning = { send: s2.status, turnInFlightDuring: during.json?.turnInFlight, abort: { status: ab2.status, body: ab2.json }, streamDone: !!st2.done, streamTypes: st2.frames.map((f) => { if (f.data === "[DONE]") return "[DONE]"; try { return JSON.parse(f.data).type; } catch { return "?"; } }), turnInFlightAfter: after.json?.turnInFlight, turnError: after.json?.turnError, lastMessage: after.json?.messages?.at(-1) && { role: after.json.messages.at(-1).role, stopReason: after.json.messages.at(-1).stopReason } };
		note("c.abort-running", results.abortRunning);
		results.abortChatId = id2;
	}
	// image route: unknown snapshot
	const img = await raw("GET", `/api/chats/${chatId}/images/zz-missing`, B);
	results.imageMissing = { status: img.status, body: img.json ?? img.text };
	// a mismatched native client on the same token
	const mm = await raw("GET", "/api/chats", { ...B, "x-learnharness-protocol": "2" });
	results.mismatchWithToken = { status: mm.status, body: mm.json };
	results.chatId = chatId;
	// bad token, protocol 1
	const bt = await raw("GET", "/api/chats", { ...P, authorization: "Bearer nope" });
	results.badToken = { status: bt.status, body: bt.json };
}
fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(results, null, 2));
console.log("wrote", path.join(outDir, "result.json"));
