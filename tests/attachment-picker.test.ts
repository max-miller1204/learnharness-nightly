import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { it } from "node:test";
const { pickAttachmentPath } = createRequire(import.meta.url)("../electron/attachment-picker.cjs");

function fixture() {
	const win = {};
	const mainFrame = { url: "http://127.0.0.1:1234/" };
	const event = { sender: { mainFrame }, senderFrame: mainFrame };
	const calls: unknown[][] = [];
	const deps = {
		BrowserWindow: { fromWebContents: (sender: unknown) => sender === event.sender ? win : null },
		trustedAppWindows: new Set([win]), origin: "http://127.0.0.1:1234",
		dialog: { showOpenDialog: async (...args: unknown[]) => { calls.push(args); return { canceled: false, filePaths: ["/course/empty folder"] }; } },
	};
	return { win, mainFrame, event, deps, calls };
}

it("native attachment picker owns the dialog parent/options and returns ONE original directory path without enumeration", async () => {
	const f = fixture();
	assert.equal(await pickAttachmentPath(f.event, "folder", f.deps), "/course/empty folder");
	assert.deepEqual(f.calls, [[f.win, { properties: ["openDirectory"] }]]);
});
for (const [canceled, filePaths] of [[true, ["/ignored"]], [false, []]] as const) it(`native cancellation/empty result returns null (${canceled})`, async () => {
	const f = fixture();
	f.deps.dialog.showOpenDialog = async () => ({ canceled, filePaths: [...filePaths] });
	assert.equal(await pickAttachmentPath(f.event, "folder", f.deps), null);
});
for (const mode of [undefined, null, "files", "openDirectory", { mode: "folder" }, { properties: ["openFile"] }]) it(`rejects unsupported renderer mode ${JSON.stringify(mode)} before opening a dialog`, async () => {
	const f = fixture();
	await assert.rejects(pickAttachmentPath(f.event, mode, f.deps), /Unsupported attachment picker mode/);
	assert.deepEqual(f.calls, []);
});
for (const kind of ["unregistered window", "foreign origin", "subframe", "malformed origin", "unknown sender"] as const) it(`rejects ${kind} before opening a dialog`, async () => {
	const f = fixture();
	if (kind === "unregistered window") f.deps.trustedAppWindows.clear();
	if (kind === "foreign origin") f.mainFrame.url = "http://127.0.0.1:5678/";
	if (kind === "malformed origin") f.mainFrame.url = "not-a-url";
	if (kind === "subframe") f.event.senderFrame = { ...f.mainFrame };
	if (kind === "unknown sender") f.deps.BrowserWindow.fromWebContents = () => null;
	await assert.rejects(pickAttachmentPath(f.event, "folder", f.deps), /Untrusted desktop request/);
	assert.deepEqual(f.calls, []);
});
it("dialog errors propagate without manufacturing a path", async () => {
	const f = fixture();
	f.deps.dialog.showOpenDialog = async () => { throw new Error("fixture failure"); };
	await assert.rejects(pickAttachmentPath(f.event, "folder", f.deps), /fixture failure/);
});

it("production lh:attachment:pick handler accepts only an owned window on localOrigin", async () => {
	const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
	const mainSource = readFileSync(mainFile, "utf8");
	const mainRequire = createRequire(mainFile);
	const handles = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
	const dialogCalls: unknown[][] = [];
	const windows: FakeWindow[] = [];

	class FakeWebContents extends EventEmitter {
		mainFrame = { url: "http://127.0.0.1:9000/" };
		isDestroyed() { return false; }
		setWindowOpenHandler() {}
		getZoomFactor() { return 1; }
		send() {}
	}
	class FakeWindow extends EventEmitter {
		webContents = new FakeWebContents();
		constructor() { super(); windows.push(this); }
		loadURL(url: string) { this.webContents.mainFrame.url = url; }
		isDestroyed() { return false; }
		show() {}
		focus() {}
		static fromWebContents(contents: FakeWebContents) { return windows.find((win) => win.webContents === contents) ?? null; }
		static getAllWindows() { return [...windows]; }
		static getFocusedWindow() { return null; }
	}
	const app = Object.assign(new EventEmitter(), {
		isPackaged: false,
		name: "LearnHarness",
		setName() {},
		getPath: () => "/fixture/user-data",
		getVersion: () => "0.7.0",
		setPath() {},
		requestSingleInstanceLock: () => false,
		quit() {},
		exit() {},
		whenReady: async () => {},
	});
	const electron = {
		app,
		BrowserWindow: FakeWindow,
		dialog: {
			showOpenDialog: async (...args: unknown[]) => {
				dialogCalls.push(args);
				return { canceled: false, filePaths: ["/course/picked"] };
			},
			showMessageBox: async () => ({ response: 0 }),
		},
		Menu: { buildFromTemplate: (value: unknown) => value, setApplicationMenu() {} },
		ipcMain: {
			on() {},
			handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handles.set(channel, fn),
		},
		nativeTheme: { shouldUseDarkColors: true, themeSource: "system", on() {} },
		session: {
			defaultSession: {
				setPermissionRequestHandler() {},
				setPermissionCheckHandler() {},
			},
		},
	};
	const context = createContext({
		require: (id: string) => {
			if (id === "electron") return electron;
			if (id === "./dev-server-readiness.cjs") return { waitForDevServer: async () => {} };
			if (id === "node:fs") {
				return {
					readFileSync: () => { throw new Error("ENOENT"); },
					writeFileSync() {},
					rmSync() {},
					mkdirSync() {},
					appendFileSync() {},
				};
			}
			return mainRequire(id);
		},
		process: { argv: [], env: { LH_DEV_URL: "http://127.0.0.1:9000" }, platform: "linux", on() {} },
		__dirname: path.dirname(mainFile),
		URL,
		AbortController,
		setInterval: () => ({ unref() {} }),
		setTimeout: () => ({ unref() {} }),
		clearTimeout() {},
	});
	runInContext(mainSource, context, { filename: mainFile });
	await runInContext("main()", context);

	const handler = handles.get("lh:attachment:pick");
	assert.ok(handler, "lh:attachment:pick IPC handler is registered");
	const ownedWindow = windows[0]!;
	assert.ok(ownedWindow, "main() created the owned window");

	// Owned window at the exact app origin succeeds.
	const picked = await handler(
		{ sender: ownedWindow.webContents, senderFrame: ownedWindow.webContents.mainFrame },
		"folder",
	);
	assert.equal(picked, "/course/picked");
	assert.deepEqual(dialogCalls, [[ownedWindow, { properties: ["openDirectory"] }]]);
	dialogCalls.length = 0;

	// An unregistered window (not in trustedAppWindows) is rejected even on localOrigin.
	const unregistered = new FakeWindow();
	unregistered.webContents.mainFrame.url = "http://127.0.0.1:9000/";
	await assert.rejects(
		() => Promise.resolve(handler({ sender: unregistered.webContents, senderFrame: unregistered.webContents.mainFrame }, "folder")),
		/Untrusted desktop request/,
	);
	assert.deepEqual(dialogCalls, []);

	// The owned window on a foreign origin is rejected.
	ownedWindow.webContents.mainFrame.url = "http://127.0.0.1:9999/";
	await assert.rejects(
		() => Promise.resolve(handler({ sender: ownedWindow.webContents, senderFrame: ownedWindow.webContents.mainFrame }, "folder")),
		/Untrusted desktop request/,
	);
	assert.deepEqual(dialogCalls, []);

	// A subframe on the owned window at localOrigin is rejected.
	ownedWindow.webContents.mainFrame.url = "http://127.0.0.1:9000/";
	await assert.rejects(
		() => Promise.resolve(handler({ sender: ownedWindow.webContents, senderFrame: { url: "http://127.0.0.1:9000/" } }, "folder")),
		/Untrusted desktop request/,
	);
	assert.deepEqual(dialogCalls, []);
});
