import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { CLIENT_PROTOCOL_VERSION, PROTOCOL_HEADER, PROTOCOL_ROUTES } from "../src/client-protocol/index.ts";

const require = createRequire(import.meta.url);
const wire = require("../electron/remote-server.cjs");
const { createServerList } = require("../electron/server-list.cjs");
const { openServerList } = require("../electron/server-list-store.cjs");
const alpha = "https://one.example.test";
const beta = "https://two.example.test:8443";
const code = "23456789ABCD";

test("the packaged shell follows the pairing and protocol contracts", () => {
	assert.equal(wire.CLIENT_PROTOCOL_VERSION, CLIENT_PROTOCOL_VERSION);
	assert.equal(wire.PROTOCOL_HEADER, PROTOCOL_HEADER);
	assert.equal(wire.SERVER_INFO_PATH, PROTOCOL_ROUTES.serverInfo);
	assert.equal(wire.TOKEN_PATH, PROTOCOL_ROUTES.token);
	assert.equal(wire.SESSION_PATH, PROTOCOL_ROUTES.session);
	assert.deepEqual(wire.parsePairLink(`${beta}/pair#token=2345-6789-abcd`), { origin: beta, code });
	assert.equal(wire.normalizeCode(" 2345-6789-abcd "), code);
	for (const url of ["http://foo.test/pair", "https://user@foo.test/pair", `${alpha}/pair?x=1`, `${alpha}/other`]) {
		assert.equal(wire.parsePairLink(`${url}#token=${code}`), null);
	}
	assert.equal(wire.parsePairLink(`${alpha}/pair#token=${code}&token=${code}`), null);
	assert.equal(wire.parseOrigin("https://one.ts.net/"), "https://one.ts.net");
	for (const input of ["http://foo.test", "https://one.test/settings", "https://user@foo.test", "https://one.test#pair", "https://one.test\\pair"]) {
		assert.equal(wire.parseOrigin(input), null);
	}
});

const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	getSelectedStorageBackend: () => "gnome_libsecret",
	encryptString: (value: string) => Buffer.from([...value].reverse().join("")),
	decryptString: (buffer: Buffer) => [...buffer.toString()].reverse().join(""),
	isAsyncEncryptionAvailable: async () => true,
	encryptStringAsync: async (value: string) => fakeSafeStorage.encryptString(value),
	decryptStringAsync: async (buffer: Buffer) => ({ result: fakeSafeStorage.decryptString(buffer) }),
};
test("saved credentials are separated by origin, and Linux plaintext fallback is refused", async (t) => {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "lh-desktop-store-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const file = path.join(directory, "servers.json");
	const store = await openServerList(file, fakeSafeStorage);
	await store.savePairing(alpha, "alpha-secret");
	await store.savePairing(beta, "beta-secret");
	await store.saveDefault(beta);
	const stored = await fs.readFile(file, "utf8");
	assert(!stored.includes("secret"));
	const reopened = await openServerList(file, fakeSafeStorage);
	assert.equal(reopened.defaultServer, beta);
	assert.equal(await reopened.readToken(alpha), "alpha-secret");
	assert.equal(await reopened.readToken(beta), "beta-secret");
	const insecure = await openServerList(file, { ...fakeSafeStorage, getSelectedStorageBackend: () => "basic_text" }, "linux");
	await assert.rejects(insecure.savePairing(alpha, "new-secret"), /system credential store/);
	const switched = JSON.parse(stored);
	[switched.servers[0].credential, switched.servers[1].credential] = [switched.servers[1].credential, switched.servers[0].credential];
	await fs.writeFile(file, JSON.stringify(switched));
	await assert.rejects((await openServerList(file, fakeSafeStorage)).readToken(alpha), /read this server’s saved credential/);
});

class TestSession {
	setPermissionRequestHandler() {}
	setPermissionCheckHandler() {}
	closeAllConnections = async () => { this.closed = true; };
	closed = false;
	headersReceived: ((details: object, respond: (value: object) => void) => void) | null = null;
	webRequest = {
		onBeforeSendHeaders() {},
		onHeadersReceived: (filter: object | null, listener: typeof this.headersReceived) => { this.headersReceived = filter && listener; },
	};
}

class TestWindow extends EventEmitter {
	static all: TestWindow[] = [];
	options;
	url = "";
	destroyed = false;
	shown = false;
	snapshot: { active: string | null; defaultServer: string | null; problem: { kind: string } | null } | null = null;
	webContents = Object.assign(new EventEmitter(), {
		id: TestWindow.all.length,
		mainFrame: { url: "" },
		isDestroyed: () => this.destroyed,
		setWindowOpenHandler: (handler: () => unknown) => { assert.deepEqual(handler(), { action: "deny" }); },
		send: (_channel: string, snapshot: typeof this.snapshot) => { this.snapshot = snapshot; },
	});
	constructor(options: { webPreferences?: { preload?: string; session?: TestSession } } = {}) {
		super();
		this.options = options;
		TestWindow.all.push(this);
	}
	isDestroyed() { return this.destroyed; }
	isMinimized() { return false; }
	focus() {}
	show() { this.shown = true; }
	destroy() { this.destroyed = true; this.emit("closed"); }
	loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; }
	loadFile(file: string) { this.loadURL(pathToFileURL(file).href); }
}

test("the app-owned switch flow keeps defaults, enforces preflight and isolates remote windows", async (t) => {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "lh-desktop-switch-"));
	const originalFetch = globalThis.fetch;
	t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });
	const calls: string[] = [];
	let revoked = false;
	let offline = false;
	let incompatible = false;
	globalThis.fetch = async (input, options) => {
		const url = new URL(String(input));
		const headers = new Headers(options?.headers);
		const a = url.origin === alpha;
		calls.push(`${url.origin}${url.pathname}`);
		assert.equal(options?.credentials, "omit");
		assert.equal(options?.redirect, "error");
		assert.equal(headers.get("cookie"), null);
		if (a && offline) throw new TypeError("fixture disconnected");
		switch (url.pathname) {
			case PROTOCOL_ROUTES.serverInfo:
				assert.equal(headers.get("authorization"), null);
				return Response.json({ name: "Test server", protocolVersion: CLIENT_PROTOCOL_VERSION + Number(a && incompatible) });
			case PROTOCOL_ROUTES.token:
				assert.equal(headers.get("authorization"), null);
				assert.equal(new URLSearchParams(String(options?.body)).get("subject_token"), code);
				revoked = false;
				return Response.json({ access_token: a ? "alpha-secret" : "beta-secret", token_type: "Bearer" });
			case PROTOCOL_ROUTES.session:
				assert.equal(headers.get("authorization"), `Bearer ${a ? "alpha-secret" : "beta-secret"}`);
				return Response.json({ authenticated: !(a && revoked) });
			default: throw new Error("Unexpected request " + url.pathname);
		}
	};
	type FakeEvent = { sender: TestWindow["webContents"]; senderFrame: { url: string } };
	let handler!: (event: FakeEvent, action: string, payload?: unknown) => Promise<unknown>;
	let localStarts = 0;
	let localStops = 0;
	const boot = () => createServerList({
		app: { getPath: () => directory }, BrowserWindow: TestWindow, safeStorage: fakeSafeStorage,
		ipcMain: { handle: (_channel: string, callback: typeof handler) => { handler = callback; } },
		session: { fromPartition: () => new TestSession() },
		startLocal: async () => { localStarts++; return "http://localhost:3000"; },
		stopLocal: async () => { localStops++; },
		createLocalWindow: (url: string) => { const win = new TestWindow(); win.loadURL(url); return win; },
		setLocalMenu() {},
	});
	let controller = await boot();
	const panel = () => controller.show() as TestWindow;
	const lastWindow = () => TestWindow.all.at(-1)!;
	const send = (win: TestWindow, action: string, value?: unknown) => handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, action, value);

	await controller.launch();
	assert.equal(localStarts, 0);
	assert.deepEqual(await send(panel(), "state"), { servers: [], defaultServer: null, active: null, busy: false, problem: null, notice: "", signingIn: false });
	await send(panel(), "connect", "local");
	const local = lastWindow();
	assert.equal(localStarts, 1);
	assert.equal(panel().url.startsWith("file:"), true);
	await send(panel(), "pair", { origin: alpha, code });
	const remote = lastWindow();
	assert.equal(local.destroyed, true);
	assert.equal(localStops, 1);
	assert.equal(remote.url, alpha);
	assert.equal(remote.shown, true);
	assert.equal(remote.options.webPreferences?.preload, undefined);
	assert.deepEqual(Object.entries(remote.options.webPreferences!).filter(([key]) => key !== "session"), [
		["sandbox", true], ["contextIsolation", true], ["nodeIntegration", false],
	]);
	await assert.rejects(send(remote, "state"), /Untrusted/);
	const chooser = panel();
	await assert.rejects(handler({ sender: chooser.webContents, senderFrame: { ...chooser.webContents.mainFrame } }, "state"), /Untrusted/);
	assert.equal((await send(chooser, "state") as { defaultServer: string }).defaultServer, "local");
	await send(chooser, "default", alpha);
	await send(panel(), "pair", { origin: beta, code });
	assert.equal(remote.destroyed, true);
	assert.equal(remote.options.webPreferences?.session?.closed, true);
	assert.equal(lastWindow().url, beta);
	assert.equal((await send(panel(), "state") as { defaultServer: string }).defaultServer, alpha);
	controller.close();
	for (const window of TestWindow.all) if (!window.destroyed) window.destroy();

	controller = await boot();
	await controller.launch();
	assert.equal(lastWindow().url, alpha, "launch follows the saved default");
	assert.equal(localStarts, 1, "remote launch does not start a bundled server");
	revoked = true;
	const revokedWindow = lastWindow();
	const response = revokedWindow.options.webPreferences!.session!.headersReceived!;
	response({
		url: alpha, webContentsId: revokedWindow.webContents.id, resourceType: "mainFrame", statusCode: 200,
		responseHeaders: { "X-Middleware-Rewrite": ["http://one.example.test/pair"] },
	}, (result) => assert.deepEqual(result, { cancel: true }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(revokedWindow.destroyed, true);
	assert.equal(panel().snapshot?.problem?.kind, "pair");
	assert.equal(panel().snapshot?.defaultServer, alpha);
	const saved = await fs.readFile(path.join(directory, "servers.json"), "utf8");
	offline = true;
	await send(panel(), "connect", alpha);
	assert.equal(panel().snapshot?.problem?.kind, "retry");
	assert.equal(await fs.readFile(path.join(directory, "servers.json"), "utf8"), saved);
	offline = false;
	incompatible = true;
	calls.length = 0;
	await send(panel(), "connect", alpha);
	assert.equal(panel().snapshot?.problem?.kind, "mismatch");
	assert.deepEqual(calls, [`${alpha}${PROTOCOL_ROUTES.serverInfo}`]);
	await send(panel(), "connect", beta);
	assert.equal(lastWindow().url, beta);
	assert.equal(panel().snapshot, null);
	assert.equal((await send(panel(), "state") as { defaultServer: string }).defaultServer, alpha);
	controller.close();
	for (const window of TestWindow.all) if (!window.destroyed) window.destroy();
	await fs.rm(path.join(directory, "servers.json"));
	controller = await boot();
	await controller.launch();
	incompatible = false;
	await send(panel(), "pair", { origin: alpha, code });
	assert.equal((await send(panel(), "state") as { defaultServer: string }).defaultServer, alpha, "first successful remote setup becomes default");
	assert.equal(localStarts, 1);
});

test("bearer headers and redirects stay confined to the selected origin and main frame", () => {
	const frame = { url: alpha };
	const contents = { id: 5, mainFrame: frame, isDestroyed: () => false };
	const win = { isDestroyed: () => false, webContents: contents };
	const details = { webContentsId: 5, webContents: contents, frame, url: `${alpha}/api/events`, requestHeaders: { Cookie: "old=1" } };
	assert.deepEqual(wire.remoteHeaders(details, alpha, "fixture", win), {
		authorization: "Bearer fixture", [PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION),
	});
	for (const change of [
		{ url: `${beta}/api/events` }, { url: alpha.replace("https", "http") }, { webContentsId: 6 },
		{ resourceType: "subFrame" }, { frame: { url: alpha }, resourceType: "xhr" }, { frame: null, resourceType: "xhr" }, { initiatorOrigin: beta },
	]) {
		const output = wire.remoteHeaders({ ...details, ...change, requestHeaders: { Authorization: "Bearer fixture" } }, alpha, "fixture", win);
		assert(!JSON.stringify(output).includes("fixture"));
	}
	assert.equal(wire.remoteHeaders({ ...details, frame: null, resourceType: "mainFrame" }, alpha, "fixture", win).authorization, "Bearer fixture");
	const reply = (location: string) => ({ url: details.url, statusCode: 307, responseHeaders: { Location: [location] } });
	assert.equal(wire.allowsRemoteRedirect(reply("/chat"), alpha), true);
	for (const location of [beta, "//other.example.test", "/pair", "/%70air", "http://one.example.test", "https://user@one.example.test"]) {
		assert.equal(wire.allowsRemoteRedirect(reply(location), alpha), false, location);
	}
});
