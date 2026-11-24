import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as os from "node:os";
import { createPairingLink } from "../../selfhost/src/auth-store.ts";
import { instance } from "./support/instance.ts";

// The client protocol (docs/specs/client-protocol.md) as a native client such
// as the phone app uses it: raw HTTP against the instance, no browser. Ported
// from the protocol drive the old verification suite ran.
const SERVER_INFO = "/.well-known/learnharness/server";
const PROTOCOL = "x-learnharness-protocol";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

type Reply = { status: number; headers: Headers; json: any; text: string };
const call = async (baseUrl: string, method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> => {
	const response = await fetch(`${baseUrl}${path}`, { method, headers: init.headers, body: init.body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
	const text = await response.text();
	let json: any;
	try { json = JSON.parse(text); } catch { /* not JSON */ }
	return { status: response.status, headers: response.headers, json, text };
};

/** Reads an SSE stream until `[DONE]`, a frame holding `stopAt`, or `ms`, as the `data:` payloads. */
const stream = async (baseUrl: string, path: string, headers: Record<string, string>, ms = 30_000, stopAt?: string) => {
	const response = await fetch(`${baseUrl}${path}`, { headers: { accept: "text/event-stream", ...headers }, signal: AbortSignal.timeout(ms) });
	const frames: string[] = [];
	if (!response.body) return { status: response.status, frames, done: false };
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let end: number;
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const block = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
				if (!data) continue;
				frames.push(data);
				if (data === "[DONE]") return { status: response.status, frames, done: true };
				if (stopAt && data.includes(stopAt)) return { status: response.status, frames, done: false };
			}
		}
	} catch { /* the read timed out or the stream was cut */ } finally {
		await reader.cancel().catch(() => {});
	}
	return { status: response.status, frames, done: false };
};
const types = (frames: string[]) => frames.map((frame) => { try { return JSON.parse(frame).type as string; } catch { return frame; } });

/** Trades a fresh one-time pairing code for a bearer token, as a native client does. */
const pair = async (baseUrl: string, label: string) => {
	const state = await instance(baseUrl);
	const { code } = createPairingLink(state.dataDir, { label });
	const form = new URLSearchParams({
		grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
		subject_token: code,
		subject_token_type: "urn:learnharness:params:oauth:token-type:pairing-code",
		requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
		client_label: label,
		client_device_type: "mobile",
		client_os: "Android",
	}).toString();
	const first = await call(baseUrl, "POST", "/oauth/token", { headers: { [PROTOCOL]: "1", ...FORM }, body: form });
	const second = await call(baseUrl, "POST", "/oauth/token", { headers: { [PROTOCOL]: "1", ...FORM }, body: form });
	return { first, second, bearer: { [PROTOCOL]: "1", authorization: `Bearer ${first.json?.access_token}` } as Record<string, string> };
};

describe("client protocol", () => {
	test("server info is public, uncached and the same for any client", async ({ app }) => {
		const base = app.baseUrl;
		const port = new URL(base).port;

		const info = await call(base, "GET", SERVER_INFO);

		expect(info.status).toBe(200);
		expect(info.headers.get("cache-control")).toContain("no-store");
		expect(Object.keys(info.json).sort()).toEqual(["auth", "capabilities", "name", "protocolVersion", "version"]);
		expect(info.json.name).toBe(os.hostname());
		expect(info.json.protocolVersion).toBe(1);
		expect(info.json.auth).toEqual({
			required: true,
			bootstrapMethods: ["one-time-token"],
			sessionMethods: ["browser-session-cookie", "bearer-access-token"],
			sessionCookieName: `lh_session_${port}`,
			tokenEndpoint: "/oauth/token",
		});
		expect(info.json.capabilities.every((c: unknown) => typeof c === "string")).toBe(true);
		// A client of any version, with any credential, gets the same answer: it reads this before it can pair.
		const clients: Array<Record<string, string>> = [{ [PROTOCOL]: "2" }, { [PROTOCOL]: "1" }, { [PROTOCOL]: "abc" }, { authorization: "Bearer nope" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }];
		for (const headers of clients) {
			const again = await call(base, "GET", SERVER_INFO, { headers });
			expect(again.status).toBe(200);
			expect(again.json).toEqual(info.json);
		}
		expect((await call(base, "GET", `${SERVER_INFO}?protocol=2`)).json).toEqual(info.json);
		// The launcher's health check is untouched by the protocol.
		expect((await call(base, "GET", "/api/health")).status).toBe(200);
	});

	test("a client naming another protocol version gets 426 before the login check", async ({ app }) => {
		const base = app.baseUrl;
		const { bearer } = await pair(base, "zz-e2e version matrix");
		const routes: Array<[string, string]> = [["GET", "/api/health"], ["GET", "/api/auth/session"], ["GET", "/api/chats"], ["GET", "/pair"], ["GET", "/chat/new"], ["POST", "/oauth/token"]];

		for (const signedIn of [false, true]) {
			for (const version of ["2", "0", "1.0", "abc", ""]) {
				for (const [method, path] of routes) {
					const headers: Record<string, string> = { [PROTOCOL]: version, ...(signedIn ? { authorization: bearer.authorization! } : {}), ...(method === "POST" ? FORM : {}) };
					const refused = await call(base, method, path, { headers, body: method === "POST" ? "grant_type=x" : undefined });
					const where = `${method} ${path} header=${JSON.stringify(version)} ${signedIn ? "signed in" : "signed out"}`;
					expect(refused.status, where).toBe(426);
					expect(refused.json, where).toMatchObject({ code: "protocol_incompatible", protocolVersion: 1 });
					expect(typeof refused.json.error, where).toBe("string");
				}
			}
		}
	});

	test("a matching version, or none, goes on to the login check", async ({ app }) => {
		const base = app.baseUrl;
		const { bearer } = await pair(base, "zz-e2e version match");

		const unauthenticated: Array<Record<string, string>> = [{}, { [PROTOCOL]: "1" }];
		for (const headers of unauthenticated) {
			expect((await call(base, "GET", "/api/health", { headers })).status).toBe(200);
			expect((await call(base, "GET", "/api/chats", { headers })).status).toBe(401);
		}
		expect((await call(base, "GET", "/api/chats", { headers: bearer })).status).toBe(200);
		// The query names a version only on the two streams, and the header wins over it.
		expect((await call(base, "GET", "/api/chats?protocol=2")).status).toBe(401);
		expect((await stream(base, "/api/events?protocol=2", {}, 3000)).status).toBe(426);
		expect((await stream(base, "/api/chats/chat_zz_e2e_missing/stream?protocol=2", {}, 3000)).status).toBe(426);
		expect((await stream(base, "/api/events?protocol=1", {}, 3000)).status).toBe(401);
		expect((await stream(base, "/api/events?protocol=2", { [PROTOCOL]: "1" }, 3000)).status).toBe(401);
		expect((await stream(base, "/api/events?protocol=1", { [PROTOCOL]: "2" }, 3000)).status).toBe(426);
		expect((await stream(base, "/api/events?protocol=2", { authorization: bearer.authorization! }, 3000)).status).toBe(426);
	});

	test("a native client pairs, lists, creates, sends and watches a turn", async ({ app }) => {
		const base = app.baseUrl;
		const { first, second, bearer } = await pair(base, "zz-e2e native client");

		// The token exchange: a bearer token, once. The same code again is refused.
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toContain("no-store");
		expect(first.json.issued_token_type).toBe("urn:ietf:params:oauth:token-type:access_token");
		expect(typeof first.json.access_token).toBe("string");
		expect(second.status).toBeGreaterThanOrEqual(400);
		expect(second.status).toBeLessThan(500);
		expect(second.json?.access_token).toBeUndefined();

		// The token is good, a missing or bad one is not.
		expect((await call(base, "GET", "/api/auth/session", { headers: bearer })).status).toBe(200);
		expect((await call(base, "GET", "/api/chats", { headers: { [PROTOCOL]: "1", authorization: "Bearer nope" } })).status).toBe(401);
		// A client of another version is told so even with a good token.
		expect((await call(base, "GET", "/api/chats", { headers: { ...bearer, [PROTOCOL]: "2" } })).status).toBe(426);

		// A new session shows in the list and opens empty.
		const created = await call(base, "POST", "/api/chats", { headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ title: "zz-e2e protocol client" }) });
		expect(created.status).toBeLessThan(300);
		const chatId = created.json.id as string;
		expect(chatId).toMatch(/^chat_/);
		const list = await call(base, "GET", "/api/chats", { headers: bearer });
		expect(list.json.chats.find((c: { id: string }) => c.id === chatId)).toBeTruthy();
		const opened = await call(base, "GET", `/api/chats/${chatId}`, { headers: bearer });
		expect(opened.status).toBe(200);
		expect(opened.json.turnInFlight).toBeFalsy();

		// Send, and watch: the notification stream and the turn stream both tell of the turn, and the turn ends with [DONE].
		const events = stream(base, "/api/events?protocol=1", { authorization: bearer.authorization! }, 30_000, chatId);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const goal = `zz-e2e slow ${Date.now().toString(36)} why is the sky blue`;
		const sent = await call(base, "POST", "/api/chat", { headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ chatId, input: { type: "text", text: goal } }) });
		expect(sent.status).toBeLessThan(300);
		const turn = await stream(base, `/api/chats/${chatId}/stream`, bearer);
		expect(turn.status).toBe(200);
		expect(turn.done).toBe(true);
		const seen = types(turn.frames);
		expect(seen.at(-1)).toBe("[DONE]");
		expect(seen.slice(0, 2)).toEqual(["agent_start", "turn_start"]);
		expect(seen).toContain("agent_end");
		expect(JSON.stringify(turn.frames)).toContain("zz-e2e slow: this reply comes after a short wait.");
		const notified = await events;
		expect(notified.status).toBe(200);
		expect(JSON.stringify(notified.frames)).toContain(chatId);

		// The record holds the goal and the tutor's reply, verbatim.
		await expect.poll(async () => JSON.stringify((await call(base, "GET", `/api/chats/${chatId}`, { headers: bearer })).json?.messages ?? []), { timeout: 10_000 }).toContain("zz-e2e slow: this reply comes after a short wait.");
		const record = (await call(base, "GET", `/api/chats/${chatId}`, { headers: bearer })).json;
		expect(JSON.stringify(record.messages)).toContain(goal);
		expect(record.turnInFlight).toBeFalsy();

		// A stream opened once the turn is over says only that it settled.
		const late = await stream(base, `/api/chats/${chatId}/stream`, bearer);
		expect(types(late.frames)).toEqual(["turn-settled", "[DONE]"]);

		// An image id the record does not hold is a clean miss.
		expect((await call(base, "GET", `/api/chats/${chatId}/images/zz-missing`, { headers: bearer })).status).toBe(404);
	});

	test("a running turn stops when the client aborts it", async ({ app }) => {
		const base = app.baseUrl;
		const { bearer } = await pair(base, "zz-e2e abort client");
		const json = { ...bearer, "content-type": "application/json" };
		const created = await call(base, "POST", "/api/chats", { headers: json, body: JSON.stringify({ title: "zz-e2e protocol abort" }) });
		const chatId = created.json.id as string;

		// The fake model holds this reply back, so the turn stays running.
		await call(base, "POST", "/api/chat", { headers: json, body: JSON.stringify({ chatId, input: { type: "text", text: `zz-e2e hang ${Date.now().toString(36)}` } }) });
		const turn = stream(base, `/api/chats/${chatId}/stream`, bearer, 30_000);
		await expect.poll(async () => (await call(base, "GET", `/api/chats/${chatId}`, { headers: bearer })).json?.turnInFlight, { timeout: 15_000 }).toBeTruthy();

		const aborted = await call(base, "POST", "/api/activity/abort", { headers: json, body: JSON.stringify({ kind: "turn", id: chatId }) });
		expect(aborted.status).toBe(200);
		expect(aborted.json).toEqual({ ok: true });

		const ended = await turn;
		expect(ended.done).toBe(true);
		await expect.poll(async () => (await call(base, "GET", `/api/chats/${chatId}`, { headers: bearer })).json?.turnInFlight, { timeout: 15_000 }).toBeFalsy();
		// With nothing running, an abort says so.
		const again = await call(base, "POST", "/api/activity/abort", { headers: json, body: JSON.stringify({ kind: "turn", id: chatId }) });
		expect(again.status).toBe(409);
		expect(again.json).toMatchObject({ ok: false, reason: "not_running" });
	});
});
