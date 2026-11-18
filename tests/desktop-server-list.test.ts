import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { CLIENT_PROTOCOL_VERSION, PROTOCOL_HEADER, PROTOCOL_ROUTES } from "../src/client-protocol/index.ts";

const require = createRequire(import.meta.url);
const wire = require("../electron/remote-server.cjs");
const { createRemoteWindow } = require("../electron/remote-window.cjs");
const { createServerList } = require("../electron/server-list.cjs");
const { openServerList } = require("../electron/server-list-store.cjs");
const { hostLabel, coverWindow } = require("../electron/skeleton.cjs");
// Quiet retries wait 15 s in the app; the fixtures need only a few steps.
Object.assign(wire.retryTiming, { windowMs: 60, stepMs: 5 });
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
	assert.equal(wire.withScheme(" my-server.ts.net:8443 "), "https://my-server.ts.net:8443");
	assert.equal(wire.withScheme("one.test"), "https://one.test");
	for (const input of ["http://one.test", "https://one.test", "ftp://one.test", "//one.test", ""]) {
		assert.equal(wire.withScheme(input), input);
	}
	assert.equal(wire.parseOrigin(wire.withScheme("http://one.test")), null, "a typed scheme still has to be HTTPS");
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
	beforeSend: typeof this.headersReceived = null;
	webRequest = {
		onBeforeSendHeaders: (filter: object | null, listener: typeof this.beforeSend) => { this.beforeSend = filter && listener; },
		onHeadersReceived: (filter: object | null, listener: typeof this.headersReceived) => { this.headersReceived = filter && listener; },
	};
}

class TestView {
	static all: TestView[] = [];
	options;
	url = "";
	closed = false;
	focused = false;
	painted = false;
	background = "";
	bounds: { width: number; height: number } | null = null;
	webContents = Object.assign(new EventEmitter(), {
		setWindowOpenHandler() {},
		isDestroyed: () => this.closed,
		close: () => { this.closed = true; },
		focus: () => { this.focused = true; },
		executeJavaScript: async () => { this.painted = true; return true; },
		loadFile: async (file: string, { query = {} }: { query?: Record<string, string> } = {}) => {
			this.url = `${pathToFileURL(file).href}?${new URLSearchParams(query)}`;
		},
	});
	constructor(options: { webPreferences: Record<string, unknown> }) {
		this.options = options;
		TestView.all.push(this);
	}
	setBounds(bounds: { width: number; height: number }) { this.bounds = bounds; }
	setBackgroundColor(color: string) { this.background = color; }
}

class TestWindow extends EventEmitter {
	static all: TestWindow[] = [];
	/** The windows created since `before`, in order. */
	static since(before: number) {
		const created = TestWindow.all.slice(before);
		return { created, first: created[0]!, second: created[1]! };
	}
	options;
	contentBounds = { x: 0, y: 0, width: 1440, height: 900 };
	contentView = Object.assign(new EventEmitter(), {
		children: [] as TestView[],
		getBounds: () => this.contentBounds,
		addChildView: (view: TestView) => { this.contentView.children.push(view); },
		removeChildView: (view: TestView) => { this.contentView.children = this.contentView.children.filter((item) => item !== view); },
	});
	url = "";
	destroyed = false;
	shown = false;
	painted = false;
	/** What the first show() and the first server load found. */
	atShow: { painted: boolean; url: string } | null = null;
	atLoad: boolean[] | null = null;
	snapshot: { active: string | null; defaultServer: string | null; problem: { kind: string } | null } | null = null;
	windowOpen!: (details: { url: string; postBody?: object }) => unknown;
	webContents = Object.assign(new EventEmitter(), {
		id: TestWindow.all.length,
		mainFrame: { url: "" },
		isDestroyed: () => this.destroyed,
		focus() {},
		setWindowOpenHandler: (handler: typeof this.windowOpen) => { this.windowOpen = handler; },
		send: (_channel: string, snapshot: typeof this.snapshot) => { this.snapshot = snapshot; },
	});
	constructor(options: { backgroundColor?: string; webPreferences?: { preload?: string; session?: TestSession } } = {}) {
		super();
		this.options = options;
		TestWindow.all.push(this);
	}
	isDestroyed() { return this.destroyed; }
	isMinimized() { return false; }
	focus() {}
	show() {
		this.atShow ??= { painted: this.painted, url: this.url };
		this.shown = true;
	}
	destroy() { this.destroyed = true; this.emit("closed"); }
	async loadURL(url: string) {
		if (!url.startsWith("file:")) this.atLoad ??= this.contentView.children.map((view) => view.painted);
		this.url = url;
		this.webContents.mainFrame.url = url;
	}
	async loadFile(file: string, { query }: { query?: Record<string, string> } = {}) {
		await this.loadURL(pathToFileURL(file).href + (query ? `?${new URLSearchParams(query)}` : ""));
		this.painted = true;
		this.emit("ready-to-show");
	}
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
		app: { getPath: () => directory }, BrowserWindow: TestWindow, WebContentsView: TestView, safeStorage: fakeSafeStorage,
		ipcMain: { handle: (_channel: string, callback: typeof handler) => { handler = callback; } },
		session: { fromPartition: () => new TestSession() },
		startLocal: async () => { localStarts++; return "http://localhost:3000"; },
		stopLocal: async () => { localStops++; },
		createLocalWindow: () => { const win = new TestWindow(); return { win, load: (url: string) => win.loadURL(url) }; },
		setLocalMenu() {},
	});
	let controller = await boot();
	const panel = () => controller.show() as TestWindow;
	const lastWindow = () => TestWindow.all.at(-1)!;
	const send = (win: TestWindow, action: string, value?: unknown) => handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, action, value);

	await controller.launch();
	assert.equal(localStarts, 0);
	assert.deepEqual(await send(panel(), "state"), { servers: [], defaultServer: null, active: null, busy: false, problem: null, notice: "", signingIn: false, damaged: false });
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
	const file = path.join(directory, "servers.json");
	const saved = await fs.readFile(file, "utf8");
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
	await fs.writeFile(file, "{bad json");
	controller = await boot();
	await controller.launch();
	assert.equal((await send(panel(), "state") as { damaged: boolean }).damaged, true);
	await send(panel(), "connect", "local");
	assert.equal(lastWindow().url, "http://localhost:3000");
	assert.equal(await fs.readFile(file, "utf8"), "{bad json", "local setup leaves the damaged path alone");
	await send(panel(), "reset");
	assert.equal((await send(panel(), "state") as { damaged: boolean }).damaged, false);
	await assert.rejects(fs.lstat(file), { code: "ENOENT" });
	assert.equal(localStarts, 2);
	controller.close();
	for (const window of TestWindow.all) if (!window.destroyed) window.destroy();
	controller = await boot();
	await controller.launch();
	incompatible = false;
	await send(panel(), "pair", { origin: alpha, code });
	assert.equal((await send(panel(), "state") as { defaultServer: string }).defaultServer, alpha, "first successful remote setup becomes default");
	assert.equal(localStarts, 2);
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

test("reset detaches damaged permissions and a directory without following or deleting its contents", async (t) => {
	const home = await fs.mkdtemp(path.join(tmpdir(), "lh-desktop-reset-"));
	t.after(() => fs.rm(home, { recursive: true, force: true }));
	const file = path.join(home, "servers.json");
	for (const kind of ["mode", "directory"]) {
		if (kind === "mode") {
			if (process.platform === "win32") continue;
			await fs.writeFile(file, JSON.stringify({ version: 1, defaultServer: "local", servers: [] }), { mode: 0o644 });
			await fs.chmod(file, 0o644);
		} else {
			await fs.mkdir(file);
			await fs.writeFile(path.join(file, "keep.txt"), "fixture");
		}
		const store = await openServerList(file, fakeSafeStorage);
		assert.equal(store.damaged, true);
		assert.equal(store.defaultServer, null);
		await assert.rejects(store.saveDefault("local"), /Reset the damaged server list/);
		await store.reset();
		assert.equal(store.damaged, false);
		await assert.rejects(fs.lstat(file), { code: "ENOENT" });
		await store.saveDefault("local");
		assert.equal((await openServerList(file, fakeSafeStorage)).defaultServer, "local");
		await fs.unlink(file);
	}
	let kept = false;
	for (const name of await fs.readdir(home)) {
		const backup = path.join(home, name);
		if ((await fs.lstat(backup)).isDirectory()) kept = await fs.readFile(path.join(backup, "keep.txt"), "utf8") === "fixture";
	}
	assert.equal(kept, true);
});

test("remote browser handoff keeps the credential in main and leaves ordinary page errors in the window", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	const browser: string[] = [];
	const problems: boolean[] = [];
	const requests: string[] = [];
	const action = "/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000001";
	const provider = "https://provider.example.test/authorize?state=fixture";
	const isolated = new TestSession();
	const openExternal = async (destination: string) => { browser.push(destination); };
	const win = createRemoteWindow({
		BrowserWindow: TestWindow, session: { fromPartition: () => isolated }, origin: alpha, token: "paired-secret",
		openExternal, onProblem: (mainFrame: boolean) => problems.push(mainFrame),
	}) as TestWindow;
	globalThis.fetch = async (input, init) => {
		requests.push(String(input));
		assert.equal(String(input), alpha + action);
		assert.equal(init?.method, "POST");
		assert.equal(init?.redirect, "manual");
		assert.equal(init?.credentials, "omit");
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer paired-secret");
		return new Response(null, { status: 303, headers: { Location: provider } });
	};
	let prevented = 0;
	const event = { preventDefault: () => { prevented++; } };
	win.webContents.emit("will-navigate", event, "https://example.test/docs");
	assert.deepEqual(win.windowOpen({ url: "https://example.test/releases" }), { action: "deny" });
	win.windowOpen({ url: "file:///private/local.txt" });
	win.windowOpen({ url: "https://example.test/?token=paired%2Dsecret" });
	assert.equal(prevented, 1);
	assert.deepEqual(browser, ["https://example.test/docs", "https://example.test/releases"]);
	assert.deepEqual(win.windowOpen({ url: "about:blank" }), {
		action: "allow", overrideBrowserWindowOptions: { show: false },
	});
	const popup = new TestWindow();
	win.webContents.emit("did-create-window", popup);
	popup.webContents.emit("will-frame-navigate", { ...event, url: alpha + action, isMainFrame: true });
	assert.equal(prevented, 2);
	assert.equal(popup.destroyed, true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	isolated.beforeSend!({
		url: alpha + action, webContentsId: popup.webContents.id, resourceType: "mainFrame", method: "GET",
	}, (result) => assert.deepEqual(result, { cancel: true }));
	assert.deepEqual(requests, [alpha + action]);
	assert.deepEqual(browser, ["https://example.test/docs", "https://example.test/releases", provider]);
	assert.equal(win.destroyed, false);
	const outside = "https://elsewhere.example.test/landing";
	const redirect = {
		url: alpha + "/redirect", resourceType: "mainFrame", method: "GET", webContentsId: win.webContents.id,
		statusCode: 303, responseHeaders: { Location: [outside] },
	};
	isolated.headersReceived!(redirect, (result) => assert.deepEqual(result, {}, "a cancel here would leave a Chromium error page"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(browser.at(-1), outside);
	let stopped = 0;
	win.webContents.emit("will-redirect", { url: outside, isMainFrame: true, preventDefault: () => { stopped++; } });
	win.webContents.emit("will-redirect", { url: alpha + "/chat", isMainFrame: true, preventDefault: () => { stopped++; } });
	assert.equal(stopped, 1, "only the outside redirect is stopped, keeping the current page");
	isolated.beforeSend!({ url: outside, webContentsId: win.webContents.id, resourceType: "mainFrame", method: "GET", requestHeaders: {} },
		(result) => assert.deepEqual(result, { cancel: true }, "the bearer never follows the redirect"));
	isolated.headersReceived!({ ...redirect, resourceType: "xhr" }, (result) => assert.deepEqual(result, { cancel: true }));
	assert.equal(browser.length, 4);
	assert.deepEqual(problems, []);
	const page = { url: alpha + "/chat/deleted", resourceType: "mainFrame", webContentsId: win.webContents.id, statusCode: 404 };
	isolated.headersReceived!(page, (result) => assert.deepEqual(result, {}));
	win.webContents.emit("did-fail-load", {}, -379, "", page.url, true);
	assert.deepEqual(problems, []);
	isolated.headersReceived!({ ...page, statusCode: 401 }, (result) => assert.deepEqual(result, {}));
	win.webContents.emit("did-fail-load", {}, -105, "", page.url, true);
	assert.deepEqual(problems, [false, false], "reauthenticate before classifying a connection failure");
	win.destroy();
});

test("a new ChatGPT sign-in waits for the abandoned attempt's slow cancel before starting", { timeout: 10000 }, async (t) => {
	const { AUTHORIZE } = require("../electron/chatgpt.cjs");
	const directory = await fs.mkdtemp(path.join(tmpdir(), "lh-desktop-sign-in-"));
	const originalFetch = globalThis.fetch;
	t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });
	const operations: string[] = [];
	const opened: string[] = [];
	let releaseCancel!: () => void;
	const slowCancel = new Promise<void>((resolve) => { releaseCancel = resolve; });
	t.after(() => releaseCancel());
	let port = 0;
	globalThis.fetch = async (input, options) => {
		const url = new URL(String(input));
		const tokenFor = url.origin === alpha ? "alpha-secret" : "beta-secret";
		switch (url.pathname) {
			case PROTOCOL_ROUTES.serverInfo: return Response.json({ name: "Test server", protocolVersion: CLIENT_PROTOCOL_VERSION });
			case PROTOCOL_ROUTES.token: return Response.json({ access_token: tokenFor, token_type: "Bearer" });
			case PROTOCOL_ROUTES.session: return Response.json({ authenticated: true });
			case "/api/subscriptions/browser": {
				operations.push("browser");
				const target = new URL(AUTHORIZE);
				target.searchParams.set("redirect_uri", `http://127.0.0.1:${port}/auth/callback`);
				target.searchParams.set("state", "fixture-state");
				return new Response(null, { status: 303, headers: { Location: target.href } });
			}
			case "/api/subscriptions": {
				assert.equal(url.origin, beta);
				const body = JSON.parse(String(options?.body));
				operations.push(body.op);
				if (body.op === "cancel") {
					if (operations.filter((op) => op === "cancel").length === 1) await slowCancel;
					return Response.json({ value: {} });
				}
				port = body.desktopRedirectPort;
				return Response.json({ value: {}, browserAction: "/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000001" });
			}
			default: throw new Error("Unexpected request " + url.pathname);
		}
	};
	type FakeEvent = { sender: TestWindow["webContents"]; senderFrame: { url: string } };
	let handler!: (event: FakeEvent, action: string, payload?: unknown) => Promise<unknown>;
	const controller = await createServerList({
		app: { getPath: () => directory }, BrowserWindow: TestWindow, WebContentsView: TestView, safeStorage: fakeSafeStorage,
		ipcMain: { handle: (_channel: string, callback: typeof handler) => { handler = callback; } },
		session: { fromPartition: () => new TestSession() },
		shell: { openExternal: async (url: string) => { opened.push(url); } },
		startLocal: async () => "http://localhost:3000", stopLocal: async () => {},
		createLocalWindow: () => { const win = new TestWindow(); return { win, load: (url: string) => win.loadURL(url) }; }, setLocalMenu() {},
	});
	const panel = () => controller.show() as TestWindow;
	const send = (action: string, value?: unknown) => {
		const win = panel();
		return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, action, value);
	};
	const until = async (ready: () => boolean) => {
		for (let i = 0; i < 400 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert(ready(), "timed out waiting for the sign-in fixture");
	};
	t.after(() => {
		controller.close();
		for (const window of TestWindow.all) if (!window.destroyed) window.destroy();
	});
	await controller.launch();
	await send("pair", { origin: beta, code });
	await send("sign-in");
	await until(() => opened.length === 1);
	await send("pair", { origin: alpha, code });
	await until(() => operations.includes("cancel"));
	await send("connect", beta);
	await send("sign-in");
	assert.equal((await send("state") as { signingIn: boolean }).signingIn, true, "the retry shows the existing pending state");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(operations, ["login", "browser", "cancel"], "no new login while the old one is still cancelling");
	releaseCancel();
	await until(() => opened.length === 2);
	assert.deepEqual(operations, ["login", "browser", "cancel", "login", "browser"]);
	controller.close();
	await until(() => operations.length === 6);
});

test("quiet retries wait out a starting server, but never repeat the one-use pairing exchange", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	let replies: (() => Response)[] = [];
	let calls = 0;
	const offline = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
	globalThis.fetch = async () => {
		calls++;
		const next = replies.shift();
		if (!next) throw offline("ECONNREFUSED");
		return next();
	};
	const ok = () => Response.json({ name: "Test server", protocolVersion: CLIENT_PROTOCOL_VERSION });
	replies = [() => new Response(null, { status: 503 }), () => { throw offline("ENOTFOUND"); }, () => new Response(null, { status: 504 }), ok];
	assert.equal((await wire.checkDescriptor(alpha, { retry: true })).name, "Test server");
	assert.equal(calls, 4);
	calls = 0;
	const started = Date.now();
	globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
		calls++;
		init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
	});
	await assert.rejects(wire.checkSession(alpha, "secret", { retry: true }), { kind: "retry" });
	assert(Date.now() - started < 1000, "a silent server's attempt ends at the retry deadline");
	globalThis.fetch = async () => {
		calls++;
		const next = replies.shift();
		if (!next) throw offline("ECONNREFUSED");
		return next();
	};
	calls = 0;
	replies = [() => new Response(null, { status: 502 })];
	await assert.rejects(wire.checkDescriptor(alpha), { kind: "retry" });
	assert.equal(calls, 1, "a connect without retry fails at once");
	calls = 0;
	replies = [() => new Response(null, { status: 503 }), ok];
	await assert.rejects(wire.pairServer(alpha, code, { retry: true }), { kind: "retry" });
	assert.equal(calls, 1, "the pairing exchange is sent once");
	calls = 0;
	replies = [];
	await assert.rejects(wire.checkSession(alpha, "secret", { retry: true }), { kind: "retry" });
	assert(calls > 1, "network errors retry until the window closes");
	for (const failure of [
		new TypeError("fetch failed", { cause: new Error("unexpected redirect") }),
		offline("CERT_HAS_EXPIRED"), offline("ERR_TLS_CERT_ALTNAME_INVALID"), new TypeError("fixture without a cause"),
	]) {
		calls = 0;
		globalThis.fetch = async () => { calls++; throw failure; };
		await assert.rejects(wire.checkSession(alpha, "secret", { retry: true }), { kind: "retry" });
		assert.equal(calls, 1, `${failure.cause ?? failure.message} fails at once`);
	}
	const starts: number[] = [];
	const begun = Date.now();
	globalThis.fetch = async () => { starts.push(Date.now() - begun); throw offline("ECONNRESET"); };
	await assert.rejects(wire.checkDescriptor(alpha, { retry: true }), { kind: "retry" });
	assert(starts.length > 1);
	assert(starts.every((start) => start <= wire.retryTiming.windowMs + 2), `no attempt starts after the deadline: ${starts}`);
	assert.equal(hostLabel("https://max-desktop.tail1234.ts.net:8443"), "max-desktop");
	assert.equal(hostLabel("https://100.64.0.5:8443"), "100.64.0.5");
	assert.equal(hostLabel("https://[fd7a:115c::1]"), "fd7a:115c::1");
});

test("a launch with a default skips the list and keeps the server page under the ghost dashboard until both session checks pass", async (t) => {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "lh-desktop-ghost-"));
	const originalFetch = globalThis.fetch;
	t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });
	let transient = 0;
	let offline = false;
	let revokeLoaded = false;
	const checks: { covered: number; shown: boolean; url: string }[] = [];
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		if (offline) throw new TypeError("fixture disconnected");
		switch (url.pathname) {
			case PROTOCOL_ROUTES.serverInfo:
				if (transient > 0) { transient--; return new Response(null, { status: 503 }); }
				return Response.json({ name: "Test server", protocolVersion: CLIENT_PROTOCOL_VERSION });
			case PROTOCOL_ROUTES.token: return Response.json({ access_token: "alpha-secret", token_type: "Bearer" });
			case PROTOCOL_ROUTES.session: {
				const win = TestWindow.all.at(-1)!;
				checks.push({ covered: win.contentView.children.length, shown: win.shown, url: win.url.includes("/skeleton.html?") ? "skeleton" : win.url });
				return Response.json({ authenticated: !(revokeLoaded && win.url === alpha) });
			}
			default: throw new Error("Unexpected request " + url.pathname);
		}
	};
	type FakeEvent = { sender: TestWindow["webContents"]; senderFrame: { url: string } };
	let handler!: (event: FakeEvent, action: string, payload?: unknown) => Promise<unknown>;
	const boot = () => createServerList({
		app: { getPath: () => directory }, BrowserWindow: TestWindow, WebContentsView: TestView, safeStorage: fakeSafeStorage,
		ipcMain: { handle: (_channel: string, callback: typeof handler) => { handler = callback; } },
		session: { fromPartition: () => new TestSession() }, shell: { openExternal: async () => {} },
		startLocal: async () => "http://localhost:3000", stopLocal: async () => {},
		createLocalWindow: () => { const win = new TestWindow(); return { win, load: (url: string) => win.loadURL(url) }; },
		setLocalMenu() {}, themeMode: () => "dark",
	});
	const isList = (win: TestWindow) => win.url.split("?")[0]!.endsWith("/server-list.html");
	let controller = await boot();
	await controller.launch();
	const first = TestWindow.all.at(-1)!;
	assert(isList(first), "first run shows the list");
	const pair = (value: object) => handler({ sender: first.webContents, senderFrame: first.webContents.mainFrame }, "pair", value);
	assert.equal(new URL(first.url).searchParams.get("mode"), "dark");
	assert.equal(first.options.backgroundColor, "#141414");
	assert.equal(await pair({ origin: "http://one.example.test", code }), "Enter the HTTPS address of your server, or paste its pairing link.");
	assert.equal(await pair({ origin: "one.example.test", code: "2345" }), "Enter the 12-character pairing code.");
	assert.equal(checks.length, 0);
	await pair({ origin: " one.example.test ", code });
	assert.equal(TestWindow.all.at(-1)!.url, alpha, "an address without a scheme connects over HTTPS");
	assert.deepEqual(checks.map(({ covered }) => covered), [0, 0], "a connect from the list keeps the server window hidden instead");
	controller.close();
	for (const window of TestWindow.all) if (!window.destroyed) window.destroy();

	checks.length = 0;
	transient = 2;
	controller = await boot();
	let before = TestWindow.all.length;
	await controller.launch();
	const { created, first: remote } = TestWindow.since(before);
	assert.equal(created.length, 1, "no server list opens");
	assert.equal(transient, 0, "503 answers are retried quietly");
	assert.equal(remote.url, alpha);
	assert.equal(remote.options.backgroundColor, "#141414");
	assert.deepEqual(checks, [
		{ covered: 1, shown: true, url: "skeleton" },
		{ covered: 1, shown: true, url: alpha },
	], "the skeleton shows at once and covers the loaded page through the second check");
	assert.equal(remote.atShow?.painted, true, "the window shows only after its own page painted the skeleton");
	assert(remote.atShow?.url.includes("/skeleton.html?"));
	assert.equal(new URL(remote.atShow!.url).searchParams.get("status"), "Connecting to one…");
	assert.deepEqual(remote.atLoad, [true], "the server page loads only under a painted overlay");
	assert.equal(remote.contentView.children.length, 0, "the verified page is revealed");
	const ghost = TestView.all.at(-1)!;
	const page = new URL(ghost.url);
	assert(page.pathname.endsWith("/skeleton.html"));
	assert.equal(page.searchParams.get("status"), "Connecting to one…");
	assert.equal(page.searchParams.get("mode"), "dark");
	assert.equal(page.searchParams.get("frame"), null, "the framed remote window has no drag band");
	assert.equal(ghost.closed, true);
	assert.equal(ghost.focused, true, "keys go to the skeleton while it covers the page");
	assert.deepEqual(Object.entries(ghost.options.webPreferences).filter(([key]) => key !== "session"), [
		["sandbox", true], ["contextIsolation", true], ["nodeIntegration", false],
	]);

	remote.destroy();
	before = TestWindow.all.length;
	await controller.reopen();
	const { created: reopenedAll, first: reopened } = TestWindow.since(before);
	assert.equal(reopenedAll.length, 1, "Dock reopen also connects without the list");
	assert.equal(reopened.url, alpha);
	assert.equal(reopened.shown, true);
	assert.equal(TestView.all.at(-1)!.closed, true);

	reopened.destroy();
	revokeLoaded = true;
	before = TestWindow.all.length;
	await controller.reopen();
	const { first: revoked, second: list } = TestWindow.since(before);
	assert.equal(revoked.destroyed, true);
	assert.equal(revoked.contentView.children.length, 1, "a late revocation is never revealed");
	assert(isList(list));
	assert.equal(list.snapshot?.problem?.kind, "pair");
	list.destroy();

	before = TestWindow.all.length;
	await controller.reopen();
	assert.deepEqual(TestWindow.all.slice(before).map(isList), [true], "a waiting problem reopens the list");
	controller.close();
	for (const window of TestWindow.all) if (!window.destroyed) window.destroy();

	revokeLoaded = false;
	offline = true;
	controller = await boot();
	before = TestWindow.all.length;
	await controller.launch();
	const { first: unreachable, second: recovery } = TestWindow.since(before);
	assert.equal(unreachable.destroyed, true);
	assert(isList(recovery));
	assert.equal(recovery.snapshot?.problem?.kind, "retry");
	controller.close();
	for (const window of TestWindow.all) if (!window.destroyed) window.destroy();
});

test("This computer opens the ghost dashboard before the bundled server starts, and closing it cancels quietly", async (t) => {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "lh-desktop-ghost-local-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	type FakeEvent = { sender: TestWindow["webContents"]; senderFrame: { url: string } };
	let handler!: (event: FakeEvent, action: string, payload?: unknown) => Promise<unknown>;
	let release!: (url: string) => void;
	let refuse!: (error: Error) => void;
	let stops = 0;
	const controller = await createServerList({
		app: { getPath: () => directory }, BrowserWindow: TestWindow, WebContentsView: TestView, safeStorage: fakeSafeStorage,
		ipcMain: { handle: (_channel: string, callback: typeof handler) => { handler = callback; } },
		session: { fromPartition: () => new TestSession() },
		startLocal: (signal: AbortSignal) => new Promise((resolve, reject) => {
			release = resolve;
			refuse = reject;
			signal.addEventListener("abort", () => reject(signal.reason));
		}),
		stopLocal: async () => { stops++; },
		createLocalWindow: () => { const win = new TestWindow(); return { win, load: (url: string) => win.loadURL(url) }; },
		setLocalMenu() {}, themeMode: () => "light", platform: "darwin",
	});
	t.after(() => {
		controller.close();
		for (const window of TestWindow.all) if (!window.destroyed) window.destroy();
	});
	const isList = (win: TestWindow) => win.url.split("?")[0]!.endsWith("/server-list.html");
	await controller.launch();
	const list = TestWindow.all.at(-1)!;
	assert(isList(list));
	const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
	const pending = handler({ sender: list.webContents, senderFrame: list.webContents.mainFrame }, "connect", "local");
	const local = TestWindow.all.at(-1)!;
	assert.equal(local.shown, false, "the window waits for its first paint");
	assert.equal(list.destroyed, false, "the list stays until the window shows");
	await settle();
	assert.equal(local.shown, true, "the main window opens before the list closes");
	assert.deepEqual(local.atShow?.painted, true);
	assert.equal(new URL(local.atShow!.url).searchParams.get("status"), "Starting LearnHarness…");
	assert.equal(list.destroyed, true);
	assert.equal(local.contentView.children.length, 1);
	const ghost = new URL(TestView.all.at(-1)!.url);
	assert.equal(ghost.searchParams.get("status"), "Starting LearnHarness…");
	assert.equal(ghost.searchParams.get("mode"), "light");
	assert.equal(ghost.searchParams.get("frame"), "inset", "the band clears the macOS traffic lights");
	assert.equal(TestView.all.at(-1)!.background, "#f5f5f3");
	release("http://localhost:3000");
	await pending;
	assert.equal(local.url, "http://localhost:3000");
	assert.deepEqual(local.atLoad, [true], "the app loads only under a painted overlay");
	assert.equal(local.contentView.children.length, 0, "the app is revealed after it loads");

	local.destroy();
	let before = TestWindow.all.length;
	const cancelled = controller.reopen();
	await settle();
	const closing = TestWindow.all.at(-1)!;
	assert.equal(closing.contentView.children.length, 1);
	closing.destroy();
	await cancelled;
	assert.equal(TestWindow.all.length, before + 1, "closing the ghost dashboard opens no list");
	assert.equal(stops, 1);

	before = TestWindow.all.length;
	const failing = controller.reopen();
	await settle();
	refuse(new Error("fixture server crashed"));
	await failing;
	const { first: broken, second: recovery } = TestWindow.since(before);
	assert.equal(broken.destroyed, true);
	assert(isList(recovery));
	assert.equal(recovery.snapshot?.problem?.kind, "retry");
});

test("the setup screen offers two tiles, and a pasted pairing link fills the address and the code", async () => {
	const shell = path.join(import.meta.dirname, "../electron");
	const { window, document } = parseHTML(await fs.readFile(path.join(shell, "server-list.html"), "utf8"));
	const sent: unknown[][] = [];
	let listener!: (state: object) => void;
	const empty = { servers: [], defaultServer: null, active: null, busy: false, problem: null, notice: "", signingIn: false, damaged: false };
	const servers = {
		state: async () => empty,
		parseLink: async (text: string) => wire.parsePairLink(text),
		connect: async (server: string) => { sent.push(["connect", server]); },
		pair: async (origin: string, value: string) => { sent.push(["pair", origin, value]); return "fixture error"; },
		onChange: (next: typeof listener) => { listener = next; },
	};
	runInNewContext(await fs.readFile(path.join(shell, "server-list.js"), "utf8"), { window: { servers }, document });
	const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(document.title, "LearnHarness");
	assert.equal($("welcome").hidden, false);
	assert.equal($("run-local").querySelector(".tile-title")!.textContent, "This computer");
	$("connect-remote").onclick!(new window.Event("click") as PointerEvent);
	assert.equal($("add-server").hidden, false);
	assert.equal($("pair-title").textContent, "Connect to my server");
	const type = async (id: string, value: string) => {
		$(id).value = value;
		$(id).dispatchEvent(new window.Event("input"));
		await new Promise<void>((resolve) => setImmediate(resolve));
	};
	await type("address", `${beta}/pair#token=2345-6789-abcd`);
	assert.equal($("address").value, beta);
	assert.equal($("code").value, code);
	assert.equal($("filled").hidden, false);
	assert.equal($("filled").textContent, "Code filled in from the link.");
	await type("code", "2345-6789-abce");
	assert.equal($("filled").hidden, true, "the note leaves once the code is edited");
	await type("address", "my-server.ts.net:8443");
	assert.equal($("address").value, "my-server.ts.net:8443", "a plain address stays as typed");
	await $("pair").onsubmit!(Object.assign(new window.Event("submit"), { preventDefault() {} }) as SubmitEvent);
	assert.deepEqual(sent, [["pair", "my-server.ts.net:8443", "2345-6789-abce"]], "main adds the scheme and checks it");
	assert.equal($("form-error").textContent, "fixture error");
	listener({ ...empty, busy: true });
	assert.equal($("pair-submit").textContent, "Connecting…");
	assert.equal($("pair-submit").disabled, true);
});

test("the skeleton keeps every input from the unseen page and covers the whole content area", () => {
	const win = new TestWindow();
	const skeleton = coverWindow(win, { WebContentsView: TestView, session: { fromPartition: () => new TestSession() }, mode: "dark", status: "Connecting to one…" });
	const view = TestView.all.at(-1)!;
	let prevented = 0;
	const key = () => win.webContents.emit("before-input-event", { preventDefault: () => { prevented++; } }, { type: "keyDown", key: "a" });
	key();
	assert.equal(prevented, 1, "keys never reach the covered page");
	win.emit("focus");
	assert.equal(view.focused, true, "regaining window focus goes back to the skeleton");
	win.contentBounds = { x: 0, y: 0, width: 1440, height: 875 };
	win.contentView.emit("bounds-changed");
	assert.equal(view.bounds?.height, 875, "the Alt menu bar's content change refits the skeleton");
	skeleton.reveal();
	view.focused = false;
	key();
	win.emit("focus");
	assert.equal(prevented, 1, "the revealed page takes keys again");
	assert.equal(view.focused, false);
	assert.equal(win.contentView.children.length, 0);
	assert.equal(view.closed, true);
	win.destroy();
});

test("a second launch or Dock click during a quiet connect opens nothing new", async (t) => {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "lh-desktop-ghost-once-"));
	const originalFetch = globalThis.fetch;
	t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });
	const file = path.join(directory, "servers.json");
	const saved = await openServerList(file, fakeSafeStorage);
	await saved.savePairing(alpha, "alpha-secret");
	await saved.saveDefault(alpha);
	let answer!: () => void;
	const slow = new Promise<void>((resolve) => { answer = resolve; });
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		if (url.pathname === PROTOCOL_ROUTES.serverInfo) {
			await slow;
			return Response.json({ name: "Test server", protocolVersion: CLIENT_PROTOCOL_VERSION });
		}
		return Response.json({ authenticated: true });
	};
	const controller = await createServerList({
		app: { getPath: () => directory }, BrowserWindow: TestWindow, WebContentsView: TestView, safeStorage: fakeSafeStorage,
		ipcMain: { handle() {} }, session: { fromPartition: () => new TestSession() }, shell: { openExternal: async () => {} },
		startLocal: async () => "http://localhost:3000", stopLocal: async () => {},
		createLocalWindow: () => { const win = new TestWindow(); return { win, load: (url: string) => win.loadURL(url) }; },
		setLocalMenu() {},
	});
	t.after(() => {
		controller.close();
		for (const window of TestWindow.all) if (!window.destroyed) window.destroy();
	});
	const before = TestWindow.all.length;
	const pending = controller.launch();
	// Before the window exists, while the saved credential is read.
	controller.reopen();
	void controller.launch();
	assert.equal(TestWindow.all.length, before, "nothing opens before the ghost window");
	await new Promise<void>((resolve) => setImmediate(resolve));
	// After it exists, while the server checks run.
	assert.equal(TestWindow.all.length, before + 1);
	controller.reopen();
	await controller.launch();
	assert.equal(TestWindow.all.length, before + 1, "the pending ghost window is focused instead");
	answer();
	await pending;
	const { created, first: remote } = TestWindow.since(before);
	assert.equal(created.length, 1, "one ghost window, and no list beside it");
	assert.equal(remote.url, alpha);
});

test("the ghost dashboard's own page gets the first-load bearer, and only that local page is let in", () => {
	const skeleton = pathToFileURL(path.join(import.meta.dirname, "../electron/skeleton.html")).href + "?mode=dark&status=x";
	const frame = { url: skeleton };
	const contents = { id: 7, mainFrame: frame, isDestroyed: () => false };
	const win = { isDestroyed: () => false, webContents: contents };
	const navigation = { webContentsId: 7, resourceType: "mainFrame", url: `${alpha}/`, requestHeaders: {} };
	assert.equal(wire.remoteHeaders(navigation, alpha, "fixture", win).authorization, "Bearer fixture");
	frame.url = pathToFileURL(path.join(import.meta.dirname, "../electron/server-list.html")).href;
	assert.equal(wire.remoteHeaders(navigation, alpha, "fixture", win).authorization, undefined, "any other local page still blocks it");
	const isolated = new TestSession();
	const remote = createRemoteWindow({
		BrowserWindow: TestWindow, session: { fromPartition: () => isolated }, origin: alpha, token: "fixture",
		openExternal: async () => {}, onProblem() {},
	}) as TestWindow;
	const request = (url: string) => {
		let result: object = {};
		isolated.beforeSend!({ url, webContentsId: remote.webContents.id, resourceType: "mainFrame", method: "GET", requestHeaders: {} }, (value) => { result = value; });
		return result;
	};
	assert.deepEqual(request(skeleton), {}, "the skeleton paints in the window's own page");
	assert.deepEqual(request(frame.url), { cancel: true }, "no other local page");
	assert.notDeepEqual(request(`${alpha}/`), { cancel: true });
	assert.deepEqual(request(skeleton), { cancel: true }, "never again once the server page loads");
	remote.destroy();
});
