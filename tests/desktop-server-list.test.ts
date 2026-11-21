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
const { registerChatGPTSignInIPC } = require("../electron/remote-chatgpt-ipc.cjs");
const { openServerList } = require("../electron/server-list-store.cjs");
const { hostLabel, coverWindow, firstFrame } = require("../electron/skeleton.cjs");
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
	/** While set, overlays wait for it before their first frame. */
	static gate: Promise<void> | null = null;
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
		close: () => {
			this.closed = true;
			this.webContents.emit("destroyed");
		},
		focus: () => { this.focused = true; },
		executeJavaScript: async () => {
			await TestView.gate;
			this.painted = true;
			return true;
		},
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
	/** While set, a window's own page waits for it before a frame. */
	static frameGate: Promise<void> | null = null;
	/** Opacity, show and own-page frame steps, in order. */
	steps: string[] = [];
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
		executeJavaScript: async (script?: string) => {
			if (script && !script.startsWith("new Promise")) { this.scripts.push(script); return undefined; }
			await TestWindow.frameGate;
			this.steps.push("frame");
			return true;
		},
		setWindowOpenHandler: (handler: typeof this.windowOpen) => { this.windowOpen = handler; },
		send: (_channel: string, snapshot: typeof this.snapshot) => { this.snapshot = snapshot; },
		reload: () => { this.reloads++; },
	});
	reloads = 0;
	/** Scripts run in the page other than the first-frame probe. */
	scripts: string[] = [];
	constructor(options: { backgroundColor?: string; webPreferences?: { preload?: string; session?: TestSession } } = {}) {
		super();
		this.options = options;
		TestWindow.all.push(this);
	}
	isDestroyed() { return this.destroyed; }
	isMinimized() { return false; }
	focus() {}
	setOpacity(value: number) { this.steps.push(`opacity ${value}`); }
	show() {
		this.steps.push("show");
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
	assert.deepEqual(await send(panel(), "state"), { servers: [], defaultServer: null, active: null, busy: false, removing: false, problem: null, notice: "", damaged: false });
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
	// Only the narrow Update everything bridge (tests/update-everything.test.ts).
	assert.equal(remote.options.webPreferences?.preload, path.join(import.meta.dirname, "../electron/remote-preload.cjs"));
	assert.deepEqual(Object.entries(remote.options.webPreferences!).filter(([key]) => key !== "session"), [
		["sandbox", true], ["contextIsolation", true], ["nodeIntegration", false], ["preload", path.join(import.meta.dirname, "../electron/remote-preload.cjs")],
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

test("through the Settings bridge, a new ChatGPT sign-in waits for the abandoned attempt's slow cancel before starting", { timeout: 10000 }, async (t) => {
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
	const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => Promise<unknown>>();
	const ipcMain = { handle: (channel: string, callback: (event: FakeEvent, ...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, callback); } };
	const controller = await createServerList({
		app: { getPath: () => directory }, BrowserWindow: TestWindow, WebContentsView: TestView, safeStorage: fakeSafeStorage,
		ipcMain,
		session: { fromPartition: () => new TestSession() },
		shell: { openExternal: async (url: string) => { opened.push(url); } },
		startLocal: async () => "http://localhost:3000", stopLocal: async () => {},
		createLocalWindow: () => { const win = new TestWindow(); return { win, load: (url: string) => win.loadURL(url) }; }, setLocalMenu() {},
	});
	registerChatGPTSignInIPC(ipcMain, { current: () => controller.current(), signIn: (accountId?: string) => controller.chatgptSignIn(accountId), cancel: () => controller.chatgptCancel() });
	const panel = () => controller.show() as TestWindow;
	const send = (action: string, value?: unknown) => {
		const win = panel();
		return handlers.get("lh:server-list")!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, action, value);
	};
	// What the server's Settings page calls in the remote window: window.lh.chatgptSignIn.start().
	const signIn = () => {
		const win = controller.current()!.win as TestWindow;
		return handlers.get("lh:chatgpt-sign-in")!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, "start");
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
	const first = signIn();
	await until(() => opened.length === 1);
	await send("pair", { origin: alpha, code });
	await until(() => operations.includes("cancel"));
	await send("connect", beta);
	let second: unknown = "pending";
	void signIn().then((result) => { second = result; });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(second, "pending", "the retry waits");
	assert.deepEqual(operations, ["login", "browser", "cancel"], "no new login while the old one is still cancelling");
	releaseCancel();
	assert.deepEqual(await first, { error: "ChatGPT sign-in ended. Try again." }, "switching away ended it");
	await until(() => opened.length === 2);
	assert.deepEqual(operations, ["login", "browser", "cancel", "login", "browser"]);
	// Update everything covers the server: its sign-in ends, and its own cancel goes out.
	controller.coverForUpdate(beta, "Updating two…");
	await until(() => operations.length === 6);
	await until(() => second !== "pending");
	assert.deepEqual(second, { error: "ChatGPT sign-in ended. Try again." });
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

test("This computer opens the ghost dashboard while the bundled server starts, and closing it cancels quietly", async (t) => {
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
	let paint!: () => void;
	TestView.gate = new Promise<void>((resolve) => { paint = resolve; });
	await settle();
	assert.equal(local.shown, true, "the main window opens before the list closes");
	assert.deepEqual(local.atShow?.painted, true);
	assert.equal(new URL(local.atShow!.url).searchParams.get("status"), "Starting LearnHarness…");
	assert.equal(list.destroyed, false, "the list waits until the shown window has painted the ghost");
	TestView.gate = null;
	paint();
	await settle();
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

test("a ghost window closed before its first frame ends the connect, and the next reopen starts again", async (t) => {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "lh-desktop-ghost-unpainted-"));
	t.after(() => { TestView.gate = null; return fs.rm(directory, { recursive: true, force: true }); });
	const saved = await openServerList(path.join(directory, "servers.json"), fakeSafeStorage);
	await saved.saveDefault("local");
	const controller = await createServerList({
		app: { getPath: () => directory }, BrowserWindow: TestWindow, WebContentsView: TestView, safeStorage: fakeSafeStorage,
		ipcMain: { handle() {} }, session: { fromPartition: () => new TestSession() },
		startLocal: async () => "http://localhost:3000", stopLocal: async () => {},
		createLocalWindow: () => { const win = new TestWindow(); return { win, load: (url: string) => win.loadURL(url) }; },
		setLocalMenu() {},
	});
	t.after(() => {
		controller.close();
		for (const window of TestWindow.all) if (!window.destroyed) window.destroy();
	});
	TestView.gate = new Promise<void>(() => {});
	const before = TestWindow.all.length;
	const stuck = controller.launch();
	await new Promise<void>((resolve) => setImmediate(resolve));
	const { first: win } = TestWindow.since(before);
	assert.equal(win.shown, true);
	const overlay = TestView.all.at(-1)!;
	win.destroy();
	await stuck;
	assert.equal(overlay.closed, true);
	assert.equal(TestWindow.all.length, before + 1, "no list after the cancel");
	TestView.gate = null;
	await controller.reopen();
	const { created, second: again } = TestWindow.since(before);
	assert.equal(created.length, 2, "the connect is no longer stuck");
	assert.equal(again.url, "http://localhost:3000");
	assert.equal(again.contentView.children.length, 0);
});

test("first-frame diagnostics log only when LH_DEBUG_FIRST_FRAME=1", async () => {
	const { execFileSync } = await import("node:child_process");
	const script = `require(${JSON.stringify(path.join(import.meta.dirname, "../electron/first-frame.cjs"))}).trace("show() call", "ghostWindow")`;
	const run = (value?: string) => execFileSync(process.execPath, ["-e", script], {
		env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...(value ? { LH_DEBUG_FIRST_FRAME: value } : {}) }, encoding: "utf8",
	});
	assert.match(run("1"), /^first-frame \d+ms show\(\) call ghostWindow\n$/);
	assert.equal(run(), "");
});

test("the app preload gives the ghost dashboard page no bridge", async () => {
	const source = await fs.readFile(path.join(import.meta.dirname, "../electron/preload.cjs"), "utf8");
	const exposed = (protocol: string) => {
		const names: string[] = [];
		runInNewContext(source, {
			location: { protocol }, process: { platform: "linux", argv: [] },
			require: () => ({ contextBridge: { exposeInMainWorld: (name: string) => { names.push(name); } }, ipcRenderer: { on() {} }, webUtils: {} }),
		});
		return names;
	};
	assert.deepEqual(exposed("file:"), []);
	assert.deepEqual(exposed("http:"), ["lh"]);
});

test("Windows shows a ghost window transparent until the ghost overlay has painted, with a bounded fallback", async (t) => {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "lh-desktop-ghost-opacity-"));
	const fallback = firstFrame.fallbackMs;
	t.after(() => {
		TestWindow.frameGate = null;
		TestView.gate = null;
		firstFrame.fallbackMs = fallback;
		return fs.rm(directory, { recursive: true, force: true });
	});
	const saved = await openServerList(path.join(directory, "servers.json"), fakeSafeStorage);
	await saved.saveDefault("local");
	const boot = (platform: string) => createServerList({
		app: { getPath: () => directory }, BrowserWindow: TestWindow, WebContentsView: TestView, safeStorage: fakeSafeStorage,
		ipcMain: { handle() {} }, session: { fromPartition: () => new TestSession() },
		startLocal: async () => "http://localhost:3000", stopLocal: async () => {},
		createLocalWindow: () => { const win = new TestWindow(); return { win, load: (url: string) => win.loadURL(url) }; },
		setLocalMenu() {}, platform,
	});
	const launch = async (platform: string) => {
		const controller = await boot(platform);
		const before = TestWindow.all.length;
		await controller.launch();
		controller.close();
		const { first: win } = TestWindow.since(before);
		win.destroy();
		return win;
	};
	// What the overlays had done when the window turned opaque.
	let atOpaque: boolean[] | null = null;
	const original = TestWindow.prototype.setOpacity;
	TestWindow.prototype.setOpacity = function (this: TestWindow, value: number) {
		original.call(this, value);
		if (value === 1) atOpaque = this.contentView.children.map((view) => view.painted);
	};
	t.after(() => { TestWindow.prototype.setOpacity = original; });

	const windows = await launch("win32");
	assert.deepEqual(windows.steps, ["opacity 0", "show", "frame", "opacity 1"], "transparent, shown, drawn, then opaque");
	assert.deepEqual(atOpaque, [true], "opaque only once the ghost overlay itself has painted");
	assert.equal(windows.url, "http://localhost:3000");

	// The own page's frame alone is not enough: opacity waits for the overlay.
	firstFrame.fallbackMs = 30;
	let paint!: () => void;
	TestView.gate = new Promise<void>((resolve) => { paint = resolve; });
	atOpaque = null;
	const controller = await boot("win32");
	const before = TestWindow.all.length;
	const pending = controller.launch();
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	const { first: slow } = TestWindow.since(before);
	assert.deepEqual(slow.steps, ["opacity 0", "show", "frame"], "still transparent while the overlay hasn't painted");
	await new Promise<void>((resolve) => setTimeout(resolve, 40));
	assert.deepEqual(slow.steps.at(-1), "opacity 1", "the fallback makes it opaque anyway");
	assert.deepEqual(atOpaque, [false]);
	TestView.gate = null;
	paint();
	await pending;
	controller.close();
	slow.destroy();
	assert.equal(slow.url, "http://localhost:3000", "the connect carries on");

	TestWindow.frameGate = new Promise<void>(() => {});
	const stalled = await launch("win32");
	assert.deepEqual(stalled.steps, ["opacity 0", "show", "opacity 1"], "no frame at all: opaque anyway after the fallback");
	assert.equal(stalled.url, "http://localhost:3000");
	TestWindow.frameGate = null;

	for (const platform of ["darwin", "linux"]) {
		assert.deepEqual((await launch(platform)).steps, ["show"], `${platform} shows directly, without the opacity step`);
	}
});

test("the setup screen offers two tiles, and a pasted pairing link fills the address and the code", async () => {
	const shell = path.join(import.meta.dirname, "../electron");
	const { window, document } = parseHTML(await fs.readFile(path.join(shell, "server-list.html"), "utf8"));
	const sent: unknown[][] = [];
	let listener!: (state: object) => void;
	const empty = { servers: [], defaultServer: null, active: null, busy: false, problem: null, notice: "", damaged: false };
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

test("Update everything: the relaunch reopens its server once, and a covered restart is quiet until the run ends", async (t) => {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "lh-desktop-update-everything-"));
	const originalFetch = globalThis.fetch;
	t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });
	const saved = await openServerList(path.join(directory, "servers.json"), fakeSafeStorage);
	await saved.savePairing(alpha, "alpha-secret");
	await saved.savePairing(beta, "beta-secret");
	await saved.saveDefault(alpha);
	const calls: string[] = [];
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		calls.push(`${url.origin}${url.pathname}`);
		if (url.pathname === PROTOCOL_ROUTES.serverInfo) return Response.json({ name: "Test server", protocolVersion: CLIENT_PROTOCOL_VERSION });
		if (url.pathname === PROTOCOL_ROUTES.session) return Response.json({ authenticated: true });
		throw new Error("Unexpected request " + url.pathname);
	};
	const controller = await createServerList({
		app: { getPath: () => directory }, BrowserWindow: TestWindow, WebContentsView: TestView, safeStorage: fakeSafeStorage,
		ipcMain: { handle() {} }, session: { fromPartition: () => new TestSession() },
		startLocal: async () => "http://localhost:3000", stopLocal: async () => {},
		createLocalWindow: () => { const win = new TestWindow(); return { win, load: (url: string) => win.loadURL(url) }; },
		setLocalMenu() {},
	});
	const before = TestWindow.all.length;
	await controller.launch({ server: beta });
	const win = TestWindow.since(before).first;
	assert.equal(win.url, beta, "the server the run restarted from, not the default");
	assert.equal(saved.defaultServer, alpha);
	const current = controller.current()!;
	assert.equal(current.origin, beta);
	assert.equal(current.token, "beta-secret");
	assert.equal(current.win, win);
	assert.equal(controller.appWindow(), win, "the menu's window: the content window");

	// A run for another server never covers this one (a switch before the cover went up).
	controller.coverForUpdate(alpha, "Updating one…");
	assert.equal(win.contentView.children.length, 0);
	controller.coverForUpdate(beta, "Updating two to 0.6.1-nightly.20261118.72… This can take a few minutes.");
	const cover = win.contentView.children.at(-1)!;
	await cover.webContents.loadFile("x");
	assert.ok(cover.options.webPreferences, "the ghost dashboard lies over the page");
	const seen = calls.length;
	win.webContents.emit("did-fail-load", {}, -102, "", beta, true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, seen, "no recheck while the server restarts under the cover");
	assert.equal(win.destroyed, false);

	const opened = TestWindow.all.length;
	controller.endUpdate(beta, { kind: "retry", message: "two wasn’t back after 32 minutes. Your app wasn’t changed." });
	assert.equal(win.destroyed, true);
	const list = TestWindow.since(opened).first;
	assert.deepEqual(list.snapshot?.problem, { server: beta, kind: "retry", message: "two wasn’t back after 32 minutes. Your app wasn’t changed." });
	assert.equal(controller.current(), null);
	assert.equal(controller.appWindow(), null, "with only the list open, no app window: never the list panel");
	assert.notEqual(list, null);

	// Later: the same window stays and loads the updated server's page. Destroying it first
	// would leave no window, and Windows and Linux quit then (the 91b5951 proof).
	await controller.launch({ server: beta });
	const again = controller.current()!.win as TestWindow;
	controller.coverForUpdate(beta, "Updating two…");
	assert.equal(again.contentView.children.length, 1);
	const reopened = TestWindow.all.length;
	await controller.endUpdate(beta, null, { version: "0.6.1-nightly.20261118.72" });
	assert.equal(again.destroyed, false, "never zero windows");
	assert.equal(TestWindow.all.length, reopened, "no replacement window");
	assert.equal(again.contentView.children.length, 0, "the cover is gone");
	assert.equal(again.reloads, 1, "the updated server's page loads in it, once");
	assert.equal(again.scripts.length, 1, "after claiming that version in the page's once-per-version memory (#264)");
	assert.match(again.scripts[0]!, /lh-auto-reloaded-versions/);
	assert.match(again.scripts[0]!, /0\.6\.1-nightly\.20261118\.72/);

	// The page already reloaded itself under the cover (#264): Later adds no second reload.
	controller.coverForUpdate(beta, "Updating two…");
	again.webContents.emit("did-navigate", {}, `${beta}/`, 200);
	await controller.endUpdate(beta, null, { version: "0.6.1-nightly.20261118.72" });
	assert.equal(again.reloads, 1, "still one reload");
	assert.equal(again.scripts.length, 1);
	assert.equal(again.contentView.children.length, 0);
	// A failed load under the cover (the proxy's 502) is not a reload of the new version.
	controller.coverForUpdate(beta, "Updating two…");
	again.webContents.emit("did-navigate", {}, `${beta}/`, 502);
	await controller.endUpdate(beta, null, { version: "0.6.1-nightly.20261118.72" });
	assert.equal(again.reloads, 2);
	assert.equal(controller.current()?.win, again);
	assert.equal(controller.current()?.origin, beta);
	const rechecked = calls.length;
	again.options.webPreferences!.session!.headersReceived!({ webContentsId: again.webContents.id, url: `${beta}/api/x`, resourceType: "xhr", statusCode: 401, responseHeaders: {} }, () => {});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(calls.length > rechecked, "rechecks are on again");
	const quiet = TestWindow.all.length;
	await controller.endUpdate(beta, null);
	assert.equal(TestWindow.all.length, quiet, "without a cover, Later leaves the open page alone");

	// A switch to another server mid-run: the run's end leaves that server's window alone.
	controller.coverForUpdate(beta, "Updating two…");
	await controller.launch({ server: alpha });
	const other = controller.current()!.win as TestWindow;
	assert.equal(controller.current()!.origin, alpha);
	const checks = calls.length;
	// A 401 on one of its requests makes the shell recheck that server.
	other.options.webPreferences!.session!.headersReceived!({ webContentsId: other.webContents.id, url: `${alpha}/api/x`, resourceType: "xhr", statusCode: 401, responseHeaders: {} }, () => {});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(calls.length > checks, "the other server's rechecks are on");
	assert.equal(controller.current()?.win, other);
	controller.endUpdate(beta, { kind: "retry", message: "two wasn’t back after 32 minutes. Your app wasn’t changed." });
	assert.equal(controller.current()?.win, other, "the open window stays");
	assert.equal(other.destroyed, false);
	const windows = TestWindow.all.length;
	await controller.endUpdate(beta, null);
	assert.equal(TestWindow.all.length, windows, "Later doesn't switch back");
});
const unreachableMessage = "Couldn’t reach the LearnHarness server. Check the address and connection, then retry.";
const savedCredential = (origin: string, token: string) => fakeSafeStorage.encryptString(JSON.stringify({ origin, token })).toString("base64");

test("Remove forgets a saved server with an ordinary write, a removed default stays empty, and old lists stay readable", async (t) => {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "lh-desktop-remove-store-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const file = path.join(directory, "servers.json");
	// Lists as earlier versions wrote them: no setUp field.
	const writeOld = (defaultServer: string | null) => fs.writeFile(file, JSON.stringify({
		defaultServer, version: 1,
		servers: [{ origin: alpha, credential: savedCredential(alpha, "alpha-secret") }, { origin: beta, credential: savedCredential(beta, "beta-secret") }],
	}), { mode: 0o600 });
	await writeOld(null);
	const unfinished = await openServerList(file, fakeSafeStorage);
	assert.equal(unfinished.damaged, false);
	assert.equal(unfinished.firstSetup, true, "an old list paired but never connected is still in its first setup");
	await writeOld(beta);
	const store = await openServerList(file, fakeSafeStorage);
	assert.equal(store.damaged, false);
	assert.equal(store.firstSetup, false, "an old list with a default has finished setup");
	assert.deepEqual(store.origins, [alpha, beta]);
	await store.remove(beta);
	assert.deepEqual(store.origins, [alpha]);
	assert.equal(store.defaultServer, null, "removing the default leaves no launch default");
	assert.equal(store.firstSetup, false, "a removed default isn't a first setup");
	await store.remove("https://unknown.example.test");
	const reopened = await openServerList(file, fakeSafeStorage);
	assert.equal(reopened.damaged, false);
	assert.deepEqual(reopened.origins, [alpha]);
	assert.equal(reopened.firstSetup, false, "still set up after a restart");
	assert.equal(await reopened.readToken(alpha), "alpha-secret");
	await assert.rejects(reopened.readToken(beta), { kind: "pair" });
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
		defaultServer: null, servers: [{ origin: alpha, credential: savedCredential(alpha, "alpha-secret") }], setUp: true, version: 1,
	});
	await reopened.savePairing(beta, "beta-secret");
	assert.equal(reopened.firstSetup, false, "pairing again keeps the record");
	await reopened.saveDefault("local");
	await reopened.remove(alpha);
	assert.equal(reopened.defaultServer, "local", "another default stays");
	await reopened.remove(beta);
	assert.equal(reopened.firstSetup, false, "This computer is still the default, so setup stays done");

	// Every saved server and the default gone: back at first setup, also after a restart.
	await writeOld(alpha);
	const emptied = await openServerList(file, fakeSafeStorage);
	await emptied.remove(alpha);
	assert.equal(emptied.firstSetup, false, "beta is still saved");
	await emptied.remove(beta);
	assert.equal(emptied.firstSetup, true);
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { defaultServer: null, servers: [], setUp: false, version: 1 });
	assert.equal((await openServerList(file, fakeSafeStorage)).firstSetup, true);
	await emptied.savePairing(alpha, "alpha-secret");
	assert.equal(emptied.firstSetup, true, "pairing on the setup screen is still first setup until it connects");
	// A list that says set up but holds nothing reads as first setup.
	await fs.writeFile(file, JSON.stringify({ defaultServer: null, servers: [], setUp: true, version: 1 }));
	assert.equal((await openServerList(file, fakeSafeStorage)).firstSetup, true);
});

type Published = { busy: boolean; removing: boolean; problem: { server: string; kind: string; message: string } | null; servers: string[] };
/** A list over saved alpha and beta (default beta), with fetch and the confirm dialog under the test's control. */
async function removalFixture(t: test.TestContext, { defaultServer = beta as string | null, setUp = true, content = "", platform = "linux" } = {}) {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "lh-desktop-remove-"));
	const originalFetch = globalThis.fetch;
	t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });
	const file = path.join(directory, "servers.json");
	await fs.writeFile(file, content || JSON.stringify({
		defaultServer, version: 1, ...(setUp ? {} : { setUp: false }),
		servers: [{ origin: alpha, credential: savedCredential(alpha, "alpha-secret") }, { origin: beta, credential: savedCredential(beta, "beta-secret") }],
	}), { mode: 0o600 });
	const fixture = {
		file,
		/** Servers that refuse connections. */
		down: new Set<string>(),
		/** Requests, as "origin path bearer". */
		calls: [] as string[],
		/** While set for an origin, its descriptor requests wait for the promise. */
		holdDescriptor: new Map<string, Promise<void>>(),
		/** Origins (or an origin and path) whose next answers are 503s, by count. */
		unavailable: new Map<string, number>(),
		/** The server an Update everything run is updating. */
		updating: null as string | null,
		answer: 1,
		asked: [] as { parent: unknown; options: { message: string; buttons: string[]; defaultId: number; cancelId: number } }[],
		/** Every snapshot the list was sent, in order. */
		published: [] as Published[],
		/** Runs on each snapshot as it is sent. */
		onPublish: (_state: Published) => {},
		localStarts: 0,
	};
	globalThis.fetch = async (input, options) => {
		const url = new URL(String(input));
		const bearer = new Headers(options?.headers).get("authorization");
		fixture.calls.push(`${url.origin} ${url.pathname} ${bearer ?? "-"}`);
		if (url.pathname === PROTOCOL_ROUTES.serverInfo) await fixture.holdDescriptor.get(url.origin);
		const key = fixture.unavailable.has(`${url.origin}${url.pathname}`) ? `${url.origin}${url.pathname}` : url.origin;
		const busyFor = fixture.unavailable.get(key) ?? 0;
		if (busyFor > 0) {
			fixture.unavailable.set(key, busyFor - 1);
			return new Response(null, { status: 503 });
		}
		if (fixture.down.has(url.origin)) throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
		if (url.pathname === PROTOCOL_ROUTES.serverInfo) return Response.json({ name: "Test server", protocolVersion: CLIENT_PROTOCOL_VERSION });
		if (url.pathname === PROTOCOL_ROUTES.session) return Response.json({ authenticated: true });
		if (url.pathname === PROTOCOL_ROUTES.token) return Response.json({ access_token: url.origin === alpha ? "alpha-secret" : "beta-secret", token_type: "Bearer" });
		throw new Error("Unexpected request " + url.pathname);
	};
	type FakeEvent = { sender: TestWindow["webContents"]; senderFrame: { url: string } };
	let handler!: (event: FakeEvent, action: string, payload?: unknown) => Promise<unknown>;
	const controller = await createServerList({
		app: { getPath: () => directory }, BrowserWindow: TestWindow, WebContentsView: TestView, safeStorage: fakeSafeStorage,
		ipcMain: { handle: (_channel: string, callback: typeof handler) => { handler = callback; } },
		session: { fromPartition: () => new TestSession() },
		dialog: {
			showMessageBox: async (parent: unknown, options: (typeof fixture.asked)[number]["options"]) => {
				fixture.asked.push({ parent, options });
				return { response: fixture.answer };
			},
		},
		startLocal: async () => { fixture.localStarts++; return "http://localhost:3000"; },
		stopLocal: async () => {},
		createLocalWindow: () => { const win = new TestWindow(); return { win, load: (url: string) => win.loadURL(url) }; },
		setLocalMenu() {},
		platform,
		updatingServer: () => fixture.updating,
	});
	const panel = () => {
		const win = controller.show() as TestWindow;
		if (!(win as unknown as { watched?: boolean }).watched) {
			(win as unknown as { watched?: boolean }).watched = true;
			const send = win.webContents.send;
			win.webContents.send = (channel: string, state: typeof win.snapshot) => {
				send(channel, state);
				const next = state as unknown as Published;
				fixture.published.push(next);
				fixture.onPublish(next);
			};
		}
		return win;
	};
	const send = (action: string, value?: unknown) => {
		const win = panel();
		return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, action, value);
	};
	const state = () => send("state") as Promise<{ servers: string[]; defaultServer: string | null; active: string | null; busy: boolean; removing: boolean; problem: { server: string; kind: string; message: string } | null }>;
	return Object.assign(fixture, { controller, panel, send, state });
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
/** Waits for `done`, up to a second. */
async function until(done: () => boolean) {
	for (let waited = 0; !done() && waited < 1000; waited += 10) await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

test("Remove asks first, forgets the server, and closes the open server it forgets", async (t) => {
	const list = await removalFixture(t);
	await list.controller.launch();
	const open = list.controller.current()!.win as TestWindow;
	assert.equal(open.url, beta);

	// T3's destructive confirm asks first, with Cancel as the default and the Esc answer.
	list.answer = 0;
	await list.send("remove", alpha);
	assert.equal(list.asked.length, 1);
	assert.equal(list.asked[0]!.parent, list.panel());
	assert.equal(list.asked[0]!.options.message, `Remove ${alpha} from this device?`);
	assert.deepEqual(list.asked[0]!.options.buttons, ["Cancel", "Confirm"]);
	assert.equal(list.asked[0]!.options.defaultId, 0);
	assert.equal(list.asked[0]!.options.cancelId, 0);
	assert.deepEqual((await list.state()).servers, [alpha, beta]);

	// The open server can be removed too: its window closes.
	list.answer = 1;
	await list.send("remove", beta);
	assert.equal(open.destroyed, true);
	assert.equal(list.controller.current(), null);
	const after = await list.state();
	assert.deepEqual(after.servers, [alpha]);
	assert.equal(after.defaultServer, null);
	assert.equal(after.busy, false);

	// This computer and unknown origins are never removed or asked about.
	const before = list.asked.length;
	await list.send("remove", "local");
	await list.send("remove", "https://unknown.example.test");
	assert.equal(list.asked.length, before);
	assert.deepEqual((await openServerList(list.file, fakeSafeStorage)).origins, [alpha]);
});

test("a removal shows Removing…, not Connecting…, and a default removed while other servers remain isn't replaced by a later connect", async (t) => {
	const list = await removalFixture(t);
	await list.controller.launch();
	await list.send("remove", beta);
	const during = list.published.filter((state) => state.removing);
	assert.ok(during.length > 0, "the list hears about the removal");
	assert.ok(during.every((state) => state.busy), "its controls are disabled meanwhile");

	// The page's notice: Removing…, never Connecting….
	const shell = path.join(import.meta.dirname, "../electron");
	const { document } = parseHTML(await fs.readFile(path.join(shell, "server-list.html"), "utf8"));
	let listener!: (state: object) => void;
	const quiet = { servers: [alpha], defaultServer: null, active: null, busy: false, removing: false, problem: null, notice: "", damaged: false };
	runInNewContext(await fs.readFile(path.join(shell, "server-list.js"), "utf8"), {
		window: { servers: { state: async () => quiet, onChange: (next: typeof listener) => { listener = next; } } }, document,
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	listener({ ...quiet, ...during[0] });
	assert.equal(document.getElementById("notice")!.textContent, "Removing…");
	assert.equal(document.getElementById("pair-submit")!.textContent, "Connect");
	listener({ ...quiet, busy: true });
	assert.equal(document.getElementById("notice")!.textContent, "Connecting…", "a connect still says so");

	// Connect, This computer, Dock reopen and Retry all leave the launch default empty.
	await list.send("connect", alpha);
	assert.equal(list.controller.current()?.origin, alpha);
	assert.equal((await list.state()).defaultServer, null, "Connect doesn't make a default");
	await list.send("connect", "local");
	assert.equal((await list.state()).defaultServer, null, "This computer doesn't make a default");
	await list.send("connect", alpha);
	await list.controller.reopen();
	assert.equal((await list.state()).defaultServer, null, "Dock reopen doesn't make a default");
	list.down.add(alpha);
	await list.send("connect", alpha);
	assert.equal((await list.state()).problem?.kind, "retry");
	list.down.delete(alpha);
	await list.send("connect", alpha);
	assert.equal((await list.state()).defaultServer, null, "Retry doesn't make a default");
	assert.equal((await openServerList(list.file, fakeSafeStorage)).defaultServer, null);
	// Set as default still works.
	await list.send("default", alpha);
	assert.equal((await list.state()).defaultServer, alpha);
});

test("once every saved server and the default are removed, the setup screen's pick becomes the default again", async (t) => {
	for (const pick of ["local", "paired"]) {
		const list = await removalFixture(t);
		await list.controller.launch();
		await list.send("remove", beta);
		await list.send("connect", "local");
		assert.equal((await list.state()).defaultServer, null, `${pick}: alpha is still saved, so no default yet`);
		await list.send("remove", alpha);
		assert.deepEqual((await list.state()).servers, []);
		list.controller.close();
		for (const window of TestWindow.all) if (!window.destroyed) window.destroy();

		// The next launch over the emptied list: no default, so the setup screen shows.
		const next = await removalFixture(t, { content: await fs.readFile(list.file, "utf8") });
		const windows = TestWindow.all.length;
		await next.controller.launch();
		assert.equal(TestWindow.all.length, windows + 1, "only the list opens");
		const opened = await next.state();
		assert.deepEqual([opened.servers, opened.defaultServer, opened.active, opened.problem], [[], null, null, null]);
		if (pick === "local") {
			await next.send("connect", "local");
			assert.equal((await next.state()).defaultServer, "local", "This computer becomes the default");
		} else {
			await next.send("pair", { origin: alpha, code });
			assert.equal(next.controller.current()?.origin, alpha);
			assert.equal((await next.state()).defaultServer, alpha, "the newly paired server becomes the default");
		}
		assert.equal((await openServerList(next.file, fakeSafeStorage)).defaultServer, pick === "local" ? "local" : alpha);
		next.controller.close();
		for (const window of TestWindow.all) if (!window.destroyed) window.destroy();
	}
});

test("the first setup of an old list paired but never connected still saves its default", async (t) => {
	const list = await removalFixture(t, { defaultServer: null });
	await list.send("connect", alpha);
	assert.equal((await list.state()).defaultServer, alpha);
	const fresh = await removalFixture(t, { defaultServer: null, setUp: false });
	await fresh.send("connect", "local");
	assert.equal((await fresh.state()).defaultServer, "local");
});

test("Switch server waits out a restarting server, then says when the open server is gone", async (t) => {
	const list = await removalFixture(t);
	await list.controller.launch();
	const open = list.controller.current()!.win as TestWindow;

	// Down for a moment: the retry window covers it and the page stays.
	list.down.add(beta);
	setTimeout(() => list.down.delete(beta), 15);
	const before = list.calls.length;
	list.controller.show({ check: true });
	await until(() => list.calls.slice(before).some((call) => call.startsWith(`${beta} ${PROTOCOL_ROUTES.session}`)));
	await settle();
	assert.equal(open.destroyed, false, "a server back within the retry window keeps its page");
	assert.equal((await list.state()).problem, null);
	assert.ok(list.calls.filter((call) => call.startsWith(`${beta} ${PROTOCOL_ROUTES.serverInfo}`)).length > 2, "it retried");

	// Still down past the window: the list says so, with Retry.
	list.down.add(beta);
	list.controller.show();
	await settle();
	assert.equal(open.destroyed, false, "plain show() leaves the open server alone");
	const panel = list.controller.show({ check: true }) as TestWindow;
	await settle();
	assert.equal(open.destroyed, false, "the page stays while the retry window runs");
	await until(() => open.destroyed);
	assert.equal(open.destroyed, true);
	assert.deepEqual(panel.snapshot?.problem, { server: beta, kind: "retry", message: unreachableMessage });
});

test("removing another server while the open server's check fails still shows the problem", async (t) => {
	const list = await removalFixture(t);
	await list.controller.launch();
	const open = list.controller.current()!.win as TestWindow;
	let release!: () => void;
	list.holdDescriptor.set(beta, new Promise<void>((resolve) => { release = resolve; }));
	list.down.add(beta);
	list.controller.show({ check: true });
	await settle();
	// The check fails while alpha's removal is writing.
	let failedDuringRemoval = false;
	list.onPublish = (state) => {
		if (state.removing && !failedDuringRemoval) { failedDuringRemoval = true; release(); }
	};
	// A non-connectivity failure ends the check at once, inside the write.
	list.down.delete(beta);
	globalThis.fetch = ((original) => async (input: RequestInfo | URL, options?: RequestInit) => {
		if (String(input).startsWith(beta)) {
			await list.holdDescriptor.get(beta);
			throw new TypeError("fixture without a cause");
		}
		return original(input, options);
	})(globalThis.fetch);
	await list.send("remove", alpha);
	await settle();
	assert.equal(failedDuringRemoval, true);
	assert.equal(open.destroyed, true, "the dead window doesn't stay");
	const state = await list.state();
	assert.deepEqual(state.servers, [beta]);
	assert.deepEqual(state.problem, { server: beta, kind: "retry", message: unreachableMessage });
});

test("a check still waiting when its server is removed never sends the removed bearer", async (t) => {
	for (const when of ["during the write", "after the removal"]) {
		const list = await removalFixture(t);
		await list.controller.launch();
		let release!: () => void;
		list.holdDescriptor.set(beta, new Promise<void>((resolve) => { release = resolve; }));
		list.controller.show({ check: true });
		await settle();
		const sent = list.calls.length;
		if (when === "during the write") list.onPublish = (state) => { if (state.removing) release(); };
		await list.send("remove", beta);
		release();
		await settle();
		const later = list.calls.slice(sent);
		assert.deepEqual(later.filter((call) => call.includes("beta-secret")), [], `${when}: no request carries the removed bearer`);
		assert.deepEqual((await list.state()).servers, [alpha]);
	}
});

test("the list offers Remove… for each saved server but not This computer, and focus goes to Add a server, or the first tile once the list is empty", async () => {
	const shell = path.join(import.meta.dirname, "../electron");
	assert.match(await fs.readFile(path.join(shell, "server-list.css"), "utf8"), /\[hidden\] \{ display: none !important; \}/, ".alert's display can't show a hidden box");
	const { window, document } = parseHTML(await fs.readFile(path.join(shell, "server-list.html"), "utf8"));
	// linkedom keeps no focus: track it as a browser does, where a removed or disabled control loses it.
	let focused: HTMLElement | null = null;
	window.HTMLElement.prototype.focus = function (this: HTMLElement) { focused = this; };
	Object.defineProperty(document, "activeElement", {
		configurable: true,
		get: () => (focused?.isConnected && !(focused as HTMLButtonElement).disabled ? focused : document.body),
	});
	const sent: unknown[][] = [];
	let listener!: (state: object) => void;
	const preview = "https://box.tail.ts.net:8444";
	const base = { servers: [beta, preview], defaultServer: beta, active: beta, busy: false, removing: false, problem: null, notice: "", damaged: false };
	let next: object = base;
	const servers = {
		state: async () => base,
		parseLink: async () => null,
		connect: async (server: string) => { sent.push(["connect", server]); },
		remove: async (server: string) => {
			sent.push(["remove", server]);
			listener({ ...base, busy: true, removing: true });
			listener(next);
		},
		onChange: (update: typeof listener) => { listener = update; },
	};
	runInNewContext(await fs.readFile(path.join(shell, "server-list.js"), "utf8"), { window: { servers }, document });
	const $ = (id: string) => document.getElementById(id) as HTMLElement;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal($("recovery").hidden, true, "no problem, no recovery box");
	const rows = () => [...document.querySelectorAll("#servers li")];
	const removeButtons = () => [...document.querySelectorAll("#servers button")].filter((button) => button.textContent === "Remove…") as HTMLButtonElement[];
	assert.equal(rows().length, 3);
	assert.deepEqual(removeButtons().map((button) => button.getAttribute("aria-label")), [`Remove ${beta} from this device`, `Remove ${preview} from this device`]);
	assert.equal(rows()[0]!.querySelectorAll("button").length, 1, "This computer has no Remove");

	// Other servers remain: focus moves to the first visible control in the list.
	next = { ...base, servers: [beta] };
	removeButtons()[1]!.focus();
	await removeButtons()[1]!.onclick!(new window.Event("click") as PointerEvent);
	assert.deepEqual(sent, [["remove", preview]]);
	assert.equal(rows().length, 2);
	assert.equal(document.activeElement, $("add"), "Add a server");
	assert.equal($("add").textContent, "Add a server");
	listener({ ...base, servers: [beta], active: null });
	assert.equal(document.activeElement, $("add"), "a later update (the removed server's window closing) keeps it there");

	// The last server and the default go: the setup tiles show, and focus lands on the first.
	next = { ...base, servers: [], defaultServer: null, active: null };
	removeButtons()[0]!.focus();
	await removeButtons()[0]!.onclick!(new window.Event("click") as PointerEvent);
	assert.equal($("list").hidden, true);
	assert.equal(document.activeElement, $("run-local"), "Add a server is hidden with the list: the This computer tile");

	// A cancelled removal keeps focus where it was.
	listener(base);
	next = base;
	removeButtons()[0]!.focus();
	servers.remove = async (server: string) => { sent.push(["remove", server]); };
	await removeButtons()[0]!.onclick!(new window.Event("click") as PointerEvent);
	assert.equal(document.activeElement, removeButtons()[0]);

	listener({ ...base, problem: { server: preview, kind: "retry", message: unreachableMessage } });
	assert.equal($("recovery").hidden, false);
	assert.equal($("problem").textContent, unreachableMessage);
	assert.equal($("recover").textContent, "Retry");
	assert.equal($("recover").hidden, false);
	listener({ ...base, damaged: true, servers: [] });
	assert.equal(removeButtons().length, 0);
});

/** Lets the list's pending work run. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a reopen or launch during a removal never reconnects the server being removed", async (t) => {
	for (const open of [true, false]) {
		const list = await removalFixture(t);
		if (open) await list.controller.launch();
		const before = TestWindow.all.length;
		let during: Promise<unknown> | null = null;
		list.onPublish = (state) => {
			if (state.removing && !during) during = Promise.all([list.controller.reopen(), list.controller.launch()]);
		};
		const sent = list.calls.length;
		await list.send("remove", beta);
		assert.ok(during, "the reopen ran while the removal wrote");
		await during;
		await settle();
		assert.deepEqual(list.calls.slice(sent).filter((call) => call.includes("beta-secret")), [], `${open ? "open" : "closed"}: the removed bearer is never read again`);
		assert.equal(TestWindow.all.slice(before).some((win) => win.url === beta), false, "no new window onto it");
		const state = await list.state();
		assert.deepEqual(state.servers, [alpha]);
		assert.equal(state.defaultServer, null);
		list.controller.close();
		for (const window of TestWindow.all) if (!window.destroyed) window.destroy();
	}
});

test("a check's session retries stop once its server is being removed", async (t) => {
	const list = await removalFixture(t);
	await list.controller.launch();
	list.unavailable.set(`${beta}${PROTOCOL_ROUTES.session}`, 1000);
	const sent = list.calls.length;
	list.controller.show({ check: true });
	await until(() => list.calls.slice(sent).some((call) => call.includes("beta-secret")));
	assert.ok(list.calls.slice(sent).some((call) => call.includes("beta-secret")), "the check is retrying its session request");
	let removalStarted = -1;
	// Retries without a pause, so any that run during the removal's write show up.
	const step = wire.retryTiming.stepMs;
	t.after(() => { wire.retryTiming.stepMs = step; });
	list.onPublish = (state) => {
		if (state.removing && removalStarted < 0) { removalStarted = list.calls.length; wire.retryTiming.stepMs = 0; }
	};
	await list.send("remove", beta);
	wire.retryTiming.stepMs = step;
	await settle();
	await settle();
	assert.ok(removalStarted >= 0);
	assert.deepEqual(list.calls.slice(removalStarted).filter((call) => call.includes("beta-secret")), []);
	assert.deepEqual((await list.state()).servers, [alpha]);
});

test("a list emptied while This computer is open shows the setup screen, and only a pick there makes the default", async (t) => {
	for (const platform of ["darwin", "win32", "linux"]) {
		const list = await removalFixture(t, { platform });
		await list.send("connect", "local");
		assert.equal(list.controller.current(), null, "This computer has no bearer");
		await list.send("remove", alpha);
		await list.send("remove", beta);
		const state = await list.state();
		assert.deepEqual([state.servers, state.defaultServer, state.active], [[], null, "local"]);
		// A Dock reopen (or a second launch) reconnects This computer without deciding the default.
		await list.controller.reopen();
		assert.equal((await list.state()).defaultServer, null, `${platform}: reopen doesn't pick the default`);
		await list.controller.launch();
		assert.equal((await list.state()).defaultServer, null, `${platform}: launch doesn't either`);
		// The pick on the setup screen does.
		await list.send("connect", "local");
		assert.equal((await list.state()).defaultServer, "local", `${platform}: This computer picked on the setup screen`);
		list.controller.close();
		for (const window of TestWindow.all) if (!window.destroyed) window.destroy();
	}

	// The page shows the setup screen for it, not Switch server.
	const shell = path.join(import.meta.dirname, "../electron");
	const { document } = parseHTML(await fs.readFile(path.join(shell, "server-list.html"), "utf8"));
	const emptied = { servers: [], defaultServer: null, active: "local", busy: false, removing: false, problem: null, notice: "", damaged: false };
	runInNewContext(await fs.readFile(path.join(shell, "server-list.js"), "utf8"), {
		window: { servers: { state: async () => emptied, onChange() {} } }, document,
	});
	await tick();
	assert.equal(document.getElementById("welcome")!.hidden, false);
	assert.equal(document.getElementById("list")!.hidden, true);
});

test("a check that fails while Update everything covers the window leaves the window for Later", async (t) => {
	const list = await removalFixture(t);
	await list.controller.launch();
	const open = list.controller.current()!.win as TestWindow;
	list.down.add(beta);
	list.controller.show({ check: true });
	await settle();
	list.controller.coverForUpdate(beta, "Updating two…");
	await until(() => !list.calls.slice(-1)[0]?.startsWith(beta) || list.calls.length > 200);
	await settle();
	await settle();
	await settle();
	await settle();
	assert.equal(open.destroyed, false, "the covered window stays");
	assert.equal((await list.state()).problem, null);
	await list.controller.endUpdate(beta, null);
	assert.equal(open.destroyed, false, "Later has the window to reveal");
});

test("Switch server during a page failure's check still waits out a restarting server", async (t) => {
	const list = await removalFixture(t);
	await list.controller.launch();
	const open = list.controller.current()!.win as TestWindow;
	let release!: () => void;
	list.holdDescriptor.set(beta, new Promise<void>((resolve) => { release = resolve; }));
	// The page failure's check (no retry) is waiting on the descriptor.
	open.webContents.emit("did-fail-load", {}, -102, "", beta, true);
	await tick();
	list.controller.show({ check: true });
	// The server answers 503 once: a one-try check would close the window.
	list.unavailable.set(beta, 1);
	list.holdDescriptor.delete(beta);
	release();
	await settle();
	await settle();
	assert.equal(open.destroyed, false, "the Switch server check retried and found the server back");
	assert.equal((await list.state()).problem, null);
});

test("a page failure that arrives while a check runs is acted on once that check ends", async (t) => {
	const list = await removalFixture(t);
	await list.controller.launch();
	const open = list.controller.current()!.win as TestWindow;
	let release!: () => void;
	list.holdDescriptor.set(beta, new Promise<void>((resolve) => { release = resolve; }));
	list.controller.show({ check: true });
	await tick();
	// The page is rewritten to /pair (a main-frame failure) while the check waits.
	open.options.webPreferences!.session!.headersReceived!({
		url: beta, webContentsId: open.webContents.id, resourceType: "mainFrame", statusCode: 200,
		responseHeaders: { "x-nextjs-rewritten-path": ["/pair"] },
	}, () => {});
	list.holdDescriptor.delete(beta);
	release();
	await until(() => open.destroyed);
	assert.equal(open.destroyed, true, "the broken page doesn't stay");
	assert.deepEqual((await list.state()).problem, { server: beta, kind: "retry", message: "Couldn’t load the server page. Try again." });
});

test("Remove is refused for the server Update everything is updating, with a plain reason", async (t) => {
	const list = await removalFixture(t);
	await list.controller.launch();
	list.updating = beta;
	await list.send("remove", beta);
	assert.equal(list.asked.length, 0, "not even asked");
	const state = await list.state();
	assert.deepEqual(state.servers, [alpha, beta]);
	assert.equal((state as unknown as { notice: string }).notice, "Update everything is running for this server. Try again once it finishes.");
	assert.equal(list.controller.current()?.origin, beta, "its window stays for the run");
	// Started while the dialog was open: refused after the answer too.
	list.updating = null;
	const dialog = list.asked.length;
	list.onPublish = () => {};
	const confirm = list.send("remove", beta);
	list.updating = beta;
	await confirm;
	assert.equal(list.asked.length, dialog + 1);
	assert.deepEqual((await list.state()).servers, [alpha, beta]);
	// Another server can still be removed.
	list.updating = beta;
	await list.send("remove", alpha);
	assert.deepEqual((await list.state()).servers, [beta]);
});

test("while a server is being removed, Update everything can't start against it", async (t) => {
	const list = await removalFixture(t);
	await list.controller.launch();
	let seen: unknown = "unset";
	list.onPublish = (state) => { if (state.removing && seen === "unset") seen = list.controller.current(); };
	await list.send("remove", beta);
	assert.equal(seen, null, "no selection to update while its removal writes");
});

test("the ChatGPT sign-in bridge answers only the open remote window's main frame at its origin", async () => {
	const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
	const mainFrame = { url: `${alpha}/settings` };
	const contents = { mainFrame };
	const win = { webContents: contents, isDestroyed: () => false };
	let open: { win: typeof win; origin: string } | null = { win, origin: alpha };
	const started: unknown[] = [];
	registerChatGPTSignInIPC({ handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) }, {
		current: () => open,
		signIn: async (accountId?: string) => { started.push(accountId); return { ok: true }; },
		cancel: async () => { started.push("cancel"); return { ok: true }; },
	});
	assert.deepEqual([...handlers.keys()], ["lh:chatgpt-sign-in"], "one channel");
	const handle = handlers.get("lh:chatgpt-sign-in")!;
	const id = "0b0c2a4e-6d8f-4a1b-9c3d-5e7f9a1b3c5d";
	assert.deepEqual(await handle({ sender: contents, senderFrame: mainFrame }, "start"), { ok: true });
	assert.deepEqual(await handle({ sender: contents, senderFrame: mainFrame }, "start", id), { ok: true });
	assert.deepEqual(await handle({ sender: contents, senderFrame: mainFrame }, "cancel"), { ok: true });
	assert.deepEqual(started, [undefined, id, "cancel"]);
	const refused: unknown[][] = [
		[{ sender: {}, senderFrame: mainFrame }, "start"],
		[{ sender: {}, senderFrame: mainFrame }, "cancel"],
		[{ sender: contents, senderFrame: { ...mainFrame } }, "start"],
		[{ sender: contents, senderFrame: mainFrame }],
		[{ sender: contents, senderFrame: mainFrame }, "openExternal", "https://evil.example"],
		[{ sender: contents, senderFrame: mainFrame }, "start", id, "extra"],
		[{ sender: contents, senderFrame: mainFrame }, "start", "not-an-account-id"],
		[{ sender: contents, senderFrame: mainFrame }, "start", { id }],
		[{ sender: contents, senderFrame: mainFrame }, "start", 7],
		[{ sender: contents, senderFrame: mainFrame }, "cancel", id],
	];
	for (const [event, ...args] of refused) await assert.rejects(handle(event, ...args), /Untrusted desktop request/);
	mainFrame.url = `${beta}/settings`;
	await assert.rejects(handle({ sender: contents, senderFrame: mainFrame }, "start"), /Untrusted/, "another origin");
	await assert.rejects(handle({ sender: contents, senderFrame: mainFrame }, "cancel"), /Untrusted/, "another origin can't cancel either");
	mainFrame.url = "https://evil.example/";
	await assert.rejects(handle({ sender: contents, senderFrame: mainFrame }, "start"), /Untrusted/);
	mainFrame.url = `${alpha}/settings`;
	open = null;
	await assert.rejects(handle({ sender: contents, senderFrame: mainFrame }, "start"), /Untrusted/, "no open remote window");
	assert.deepEqual(started, [undefined, id, "cancel"], "nothing refused ever ran");
});

test("the server's own sign-in is refused while it is removed or updated, and the list has no ChatGPT button", async (t) => {
	const list = await removalFixture(t);
	const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
	const ipcMain = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) };
	let runs = 0;
	registerChatGPTSignInIPC(ipcMain, { current: () => list.controller.current(), signIn: (accountId?: string) => { runs++; return list.controller.chatgptSignIn(accountId); }, cancel: () => list.controller.chatgptCancel() });
	await list.controller.launch();
	const win = list.controller.current()!.win as TestWindow;
	const handle = () => handlers.get("lh:chatgpt-sign-in")!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, "start");
	list.updating = beta;
	assert.deepEqual(await handle(), { error: "Update everything is running for this server. Try again once it finishes." });
	list.updating = null;
	let during: Promise<unknown> | null = null;
	list.onPublish = (state) => { if (state.removing && !during) during = handle().then(() => "started", () => "refused"); };
	await list.send("remove", beta);
	assert.equal(await during, "refused", "no sign-in for a server being removed");
	assert.equal(runs, 1);

	const shell = path.join(import.meta.dirname, "../electron");
	const html = await fs.readFile(path.join(shell, "server-list.html"), "utf8");
	assert.equal(/ChatGPT|sign-in/i.test(html), false, "Switch server is only for servers");
	assert.equal(/signIn|sign-in/.test(await fs.readFile(path.join(shell, "server-list.js"), "utf8")), false);
	assert.equal(/sign-in/.test(await fs.readFile(path.join(shell, "server-list-preload.cjs"), "utf8")), false);
});
