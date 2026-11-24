import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPairingLink } from "../../selfhost/src/auth-store.ts";
import { instance } from "./support/instance.ts";
import { type Frame, parse, StreamBag, streamStatus } from "./support/sse.ts";

// The client protocol (docs/specs/client-protocol.md) as a native client such
// as the phone app uses it: raw HTTP against the instance, no browser.
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

/** A turn stream, read to its end: the types of its frames. */
const turnTypes = (frames: Frame[]) => frames.map((frame) => frame.data === "[DONE]" ? "[DONE]" : (parse(frame.data)?.type as string | undefined) ?? frame.data);

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

describe("client protocol", { requires: ["browser"] }, () => {
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
		expect(await streamStatus(base, "/api/events?protocol=2", {})).toBe(426);
		expect(await streamStatus(base, "/api/chats/chat_zz_e2e_missing/stream?protocol=2", {})).toBe(426);
		expect(await streamStatus(base, "/api/events?protocol=1", {})).toBe(401);
		expect(await streamStatus(base, "/api/events?protocol=2", { [PROTOCOL]: "1" })).toBe(401);
		expect(await streamStatus(base, "/api/events?protocol=1", { [PROTOCOL]: "2" })).toBe(426);
		expect(await streamStatus(base, "/api/events?protocol=2", { authorization: bearer.authorization! })).toBe(426);
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

		const streams = new StreamBag();
		try {
			// A new session shows in the list and opens empty.
			const created = await call(base, "POST", "/api/chats", { headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ title: "zz-e2e protocol client" }) });
			expect(created.status).toBeLessThan(300);
			const chatId = created.json.id as string;
			expect(chatId).toMatch(/^chat_/);

			// Open the notification stream. A dev server sends its head with the first frame, which
			// an idle stream only has at its 25 s heartbeat, so rename the session (a "chats-changed"
			// event) until the head arrives. The head is the proof of the subscription.
			const eventsOpening = streams.add(base, "/api/events?protocol=1", { authorization: bearer.authorization! });
			let headSeen = false;
			eventsOpening.then(() => { headSeen = true; }, () => { headSeen = true; });
			for (let poke = 0; !headSeen && poke < 150; poke++) {
				await call(base, "PUT", `/api/chats/${chatId}`, { headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ title: "zz-e2e protocol client" }) });
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			const list = await call(base, "GET", "/api/chats", { headers: bearer });
			expect(list.json.chats.find((c: { id: string }) => c.id === chatId)).toBeTruthy();
			const opened = await call(base, "GET", `/api/chats/${chatId}`, { headers: bearer });
			expect(opened.status).toBe(200);
			expect(opened.json.turnInFlight).toBeFalsy();

			// Send, and watch. The notification stream is open (and so subscribed) before the send,
			// and names the turn's start and settle for this chat; the turn stream carries the
			// agent's events and ends with [DONE].
			const events = await eventsOpening;
			expect(events.status).toBe(200);
			expect(events.contentType).toContain("text/event-stream");
			expect(events.frames.some((f) => f.event === "chats-changed")).toBe(true);
			const goal = `zz-e2e slow ${Date.now().toString(36)} why is the sky blue`;
			const sent = await call(base, "POST", "/api/chat", { headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ chatId, input: { type: "text", text: goal } }) });
			expect(sent.status).toBeLessThan(300);
			const turn = await streams.add(base, `/api/chats/${chatId}/stream`, bearer);
			expect(turn.status).toBe(200);
			expect(turn.contentType).toContain("text/event-stream");
			const turnFrames = await turn.drain();
			const seen = turnTypes(turnFrames);
			expect(seen.at(-1)).toBe("[DONE]");
			expect(seen.slice(0, 2)).toEqual(["agent_start", "turn_start"]);
			expect(seen).toContain("agent_end");
			expect(JSON.stringify(turnFrames)).toContain("zz-e2e slow: this reply comes after a short wait.");
			const named = await events.until((frames) => frames.some((f) => f.event === "turn-settled" && parse(f.data)?.chatId === chatId), `turn-settled for ${chatId}`);
			const ours = named.filter((f) => parse(f.data)?.chatId === chatId).map((f) => f.event);
			expect(ours.indexOf("turn-started")).toBeGreaterThanOrEqual(0);
			expect(ours.indexOf("turn-settled")).toBeGreaterThan(ours.indexOf("turn-started"));

			// The record holds the goal and the tutor's reply, verbatim.
			await expect.poll(async () => JSON.stringify((await call(base, "GET", `/api/chats/${chatId}`, { headers: bearer })).json?.messages ?? []), { timeout: 10_000 }).toContain("zz-e2e slow: this reply comes after a short wait.");
			const record = (await call(base, "GET", `/api/chats/${chatId}`, { headers: bearer })).json;
			expect(JSON.stringify(record.messages)).toContain(goal);
			expect(record.turnInFlight).toBeFalsy();

			// A stream opened once the turn is over says only that it settled.
			const late = await streams.add(base, `/api/chats/${chatId}/stream`, bearer);
			expect(turnTypes(await late.drain())).toEqual(["turn-settled", "[DONE]"]);
		} finally {
			streams.closeAll();
		}
	});

	test("an image in a session record can be fetched by its snapshot id, and no other id finds it", async ({ app }) => {
		const base = app.baseUrl;
		const state = await instance(base);
		const { bearer } = await pair(base, "zz-e2e image client");
		const json = { ...bearer, "content-type": "application/json" };
		const chatId = (await call(base, "POST", "/api/chats", { headers: json, body: JSON.stringify({ title: "zz-e2e protocol image" }) })).json.id as string;

		// A session record refers to an image by its content's SHA-256. The tutor's show_image
		// tool is teacher-only, so put the snapshot in the stored record, as the tool would.
		const bytes = fs.readFileSync(state.fixtureImage);
		const snapshotId = crypto.createHash("sha256").update(bytes).digest("hex");
		const file = path.join(state.dataDir, "chats", `${chatId}.json`);
		const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		record.imageSnapshots = { [snapshotId]: { mimeType: "image/png", data: bytes.toString("base64"), width: 1, height: 1 } };
		fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

		const image = await call(base, "GET", `/api/chats/${chatId}/images/${snapshotId}`, { headers: bearer });
		expect(image.status).toBe(200);
		expect(image.headers.get("cache-control")).toContain("no-store");
		expect(image.json).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
		expect(Buffer.from(image.json.data, "base64").equals(fs.readFileSync(state.fixtureImage))).toBe(true);
		// A well-formed id the record does not hold, and a malformed one, are misses; so is the right id under another session.
		expect((await call(base, "GET", `/api/chats/${chatId}/images/${"0".repeat(64)}`, { headers: bearer })).status).toBe(404);
		expect((await call(base, "GET", `/api/chats/${chatId}/images/zz-missing`, { headers: bearer })).status).toBe(404);
		const other = (await call(base, "POST", "/api/chats", { headers: json, body: JSON.stringify({ title: "zz-e2e protocol image other" }) })).json.id as string;
		expect((await call(base, "GET", `/api/chats/${other}/images/${snapshotId}`, { headers: bearer })).status).toBe(404);
	});

	test("a running turn stops when the client aborts it", async ({ app }) => {
		const base = app.baseUrl;
		const { bearer } = await pair(base, "zz-e2e abort client");
		const json = { ...bearer, "content-type": "application/json" };
		const created = await call(base, "POST", "/api/chats", { headers: json, body: JSON.stringify({ title: "zz-e2e protocol abort" }) });
		const chatId = created.json.id as string;

		// The fake model holds this reply back, so the turn stays running.
		await call(base, "POST", "/api/chat", { headers: json, body: JSON.stringify({ chatId, input: { type: "text", text: `zz-e2e hang ${Date.now().toString(36)}` } }) });
		const streams = new StreamBag();
		try {
			const turn = await streams.add(base, `/api/chats/${chatId}/stream`, bearer);
			expect(turn.status).toBe(200);
			await expect.poll(async () => (await call(base, "GET", `/api/chats/${chatId}`, { headers: bearer })).json?.turnInFlight, { timeout: 15_000 }).toBeTruthy();

			const aborted = await call(base, "POST", "/api/activity/abort", { headers: json, body: JSON.stringify({ kind: "turn", id: chatId }) });
			expect(aborted.status).toBe(200);
			expect(aborted.json).toEqual({ ok: true });

			const ended = await turn.drain();
			expect(turnTypes(ended).at(-1)).toBe("[DONE]");
			expect(turnTypes(ended)).toContain("agent_end");
		} finally {
			streams.closeAll();
		}
		await expect.poll(async () => (await call(base, "GET", `/api/chats/${chatId}`, { headers: bearer })).json?.turnInFlight, { timeout: 15_000 }).toBeFalsy();
		// With nothing running, an abort says so.
		const again = await call(base, "POST", "/api/activity/abort", { headers: json, body: JSON.stringify({ kind: "turn", id: chatId }) });
		expect(again.status).toBe(409);
		expect(again.json).toMatchObject({ ok: false, reason: "not_running" });
	});
});
