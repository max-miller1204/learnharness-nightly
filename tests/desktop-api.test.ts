import "./helpers/auth-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";
import { tokenExchange } from "../src/server/auth-routes.ts";
import { listSessions } from "../selfhost/src/auth-store.ts";
import { AUTH_TEST_DATA_DIR } from "./helpers/auth-data-dir.ts";
import { browserServiceSpawnEnv } from "../src/agent/subagents/headless.ts";
const require = createRequire(import.meta.url);
const { desktopAPIHeaders, exchangeDesktopSession, HEADER } = require("../electron/desktop-api.cjs");
const { trustedSender, chatGPTControl } = require("../electron/chatgpt-ipc.cjs");
const secret = "a".repeat(64);
const token = "payload.signature";
const origin = "http://127.0.0.1:12345";

function fixture() {
	const mainFrame = { url: `${origin}/chat/new` };
	const contents = { id: 5, mainFrame, isDestroyed: () => false };
	const win = { webContents: contents, isDestroyed: () => false };
	const details = { url: `${origin}/api/settings`, webContentsId: contents.id, webContents: contents, frame: mainFrame, initiatorOrigin: origin, requestHeaders: { Accept: "application/json" } };
	return { mainFrame, contents, win, details };
}

test("desktop session header goes only on trusted app main-frame requests to the app's own origin, pages too", () => {
	const { details, win, mainFrame, contents } = fixture();
	assert.equal(desktopAPIHeaders(details, origin, token, [win])[HEADER], `Bearer ${token}`);
	assert.equal(desktopAPIHeaders({ ...details, url: `${origin}/chat/new` }, origin, token, [win])[HEADER], `Bearer ${token}`, "pages are gated too");
	for (const mutation of [
		{ url: "https://thirdparty.invalid/api/settings" },
		{ url: "http://127.0.0.1:12346/api/settings" },
		{ frame: { url: `${origin}/chat/new` } }, // forged frame identity
		{ frame: { url: "about:srcdoc", parent: mainFrame } },
		{ frame: null },
		{ webContentsId: 6 },
		{ webContents: { ...contents } },
		{ initiatorOrigin: "https://thirdparty.invalid" },
		{ initiatorOrigin: "null" },
	]) {
		const result = desktopAPIHeaders({ ...details, ...mutation, requestHeaders: { Authorization: `Bearer ${token}` } }, origin, token, [win]);
		assert(!Object.keys(result).some((key) => key.toLowerCase() === HEADER), JSON.stringify(mutation));
	}
	const foreign = desktopAPIHeaders({ ...details, url: "https://api.example/v1", requestHeaders: { Authorization: "Bearer theirs" } }, origin, token, [win]);
	assert.equal(foreign.Authorization, "Bearer theirs", "other sites' own Authorization headers are left alone");
	assert.equal(desktopAPIHeaders(details, origin, token, [])[HEADER], undefined, "other WebContents are not app windows");
	mainFrame.url = "https://thirdparty.invalid/after-navigation";
	assert.equal(desktopAPIHeaders(details, origin, token, [win])[HEADER], undefined, "navigation revokes trust even for the same native frame");
	mainFrame.url = "";
	assert.equal(desktopAPIHeaders({ ...details, url: `${origin}/` }, origin, token, [win])[HEADER], `Bearer ${token}`, "the window's first navigation");
	assert.equal(desktopAPIHeaders(details, origin, null, [win])[HEADER], undefined, "externally launched desktop dev has no session");
});

test("the per-launch secret trades for one desktop session; wrong or missing secrets fail", async () => {
	const saved = { marker: process.env.LH_DESKTOP_SERVER, secret: process.env.LH_DESKTOP_API_SECRET };
	const exchange = (subject: string) => tokenExchange(new Request(`${origin}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: subject, subject_token_type: "urn:learnharness:params:oauth:token-type:desktop-bootstrap", client_label: "LearnHarness Desktop", client_device_type: "desktop", client_os: "macOS" }),
	}));
	try {
		delete process.env.LH_DESKTOP_SERVER;
		process.env.LH_DESKTOP_API_SECRET = secret;
		assert.equal((await exchange(secret)).status, 400, "only a desktop server accepts the bootstrap");
		process.env.LH_DESKTOP_SERVER = "1";
		for (const wrong of ["", "wrong", secret + "a", secret.slice(1)]) assert.equal((await exchange(wrong)).status, 400, wrong);
		process.env.LH_DESKTOP_API_SECRET = "too-short";
		assert.equal((await exchange("too-short")).status, 400);
		process.env.LH_DESKTOP_API_SECRET = secret;
		const first = await (await exchange(secret)).json() as { access_token: string; token_type: string };
		assert.equal(first.token_type, "Bearer");
		const second = await (await exchange(secret)).json() as { access_token: string };
		const desktops = listSessions(AUTH_TEST_DATA_DIR).filter((s) => s.method === "desktop");
		assert.equal(desktops.length, 1, "each launch replaces the previous desktop session");
		assert.equal(desktops[0]?.label, "LearnHarness Desktop");
		assert.equal(desktops[0]?.os, "macOS");
		assert.equal(proxy(new NextRequest(`${origin}/api/settings`, { headers: { authorization: `Bearer ${first.access_token}` } })).status, 401, "the replaced session no longer works");
		assert.equal(proxy(new NextRequest(`${origin}/api/settings`, { headers: { authorization: `Bearer ${second.access_token}` } })).headers.get("x-middleware-next"), "1");
		assert.equal(proxy(new NextRequest(`${origin}/api/settings`, { headers: { "x-learnharness-desktop": secret } })).status, 401, "the raw secret is not a credential");
		// The shell's own client against the real handler.
		const viaShell = await exchangeDesktopSession(origin, secret, { fetchImpl: (_url: string, init: RequestInit) => tokenExchange(new Request(`${origin}/oauth/token`, init)), attempts: 1, os: "darwin" });
		assert.equal(typeof viaShell, "string");
		await assert.rejects(exchangeDesktopSession(origin, "wrong", { fetchImpl: (_url: string, init: RequestInit) => tokenExchange(new Request(`${origin}/oauth/token`, init)), attempts: 1 }));
	} finally {
		if (saved.marker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = saved.marker;
		if (saved.secret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = saved.secret;
	}
});

test("renderer controls route explicit account forgetting and account-independent boolean consent only", async () => {
	const forgotten: string[] = [], changes: boolean[] = [];
	const connection = { disconnect: async (id: string) => { forgotten.push(id); return { ok: true }; }, consent: async (enabled: boolean) => { changes.push(enabled); return { ok: true }; } };
	assert.deepEqual(await chatGPTControl({ op: "disconnect", id: "fixture-account" }, connection), { ok: true });
	assert.deepEqual(await chatGPTControl({ op: "consent", enabled: false }, connection), { ok: true });
	assert.deepEqual(forgotten, ["fixture-account"]); assert.deepEqual(changes, [false]);
	for (const command of [{ op: "disconnect" }, { op: "disconnect", id: 7 }, { op: "consent", enabled: "false" }]) assert.deepEqual(await chatGPTControl(command, connection), { error: "Unsupported ChatGPT control." });
	assert.deepEqual(changes, [false]);
});

test("renderer controls have no lease or general token bridge, and require the trusted main frame", async () => {
	let leased = false;
	const connection = { lease: async () => { leased = true; return { accessToken: "scratch-private-token" }; } };
	assert.deepEqual(await chatGPTControl({ op: "lease", background: false }, connection), { error: "Unsupported ChatGPT control." });
	assert.equal(leased, false);
	const { contents, mainFrame, win } = fixture();
	const BrowserWindow = { fromWebContents: (value: unknown) => value === contents ? win : null };
	assert(trustedSender({ sender: contents, senderFrame: mainFrame }, origin, BrowserWindow));
	assert(!trustedSender({ sender: contents, senderFrame: { url: mainFrame.url } }, origin, BrowserWindow));
	mainFrame.url = "https://thirdparty.invalid/";
	assert(!trustedSender({ sender: contents, senderFrame: mainFrame }, origin, BrowserWindow));
	assert.equal(browserServiceSpawnEnv({ LH_DESKTOP_API_SECRET: secret, LH_DESKTOP_SERVER: "1" }).LH_DESKTOP_API_SECRET, undefined);
});
