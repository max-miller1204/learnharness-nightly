/** Actual shell functions with fake Electron/updater/filesystem. No app,
 * profile, network, timer or updater download/install operation is run. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);

function fixture({ packaged = true, updaterMissing = false, installRecord = null as string | null } = {}) {
	let settings: string | Error = JSON.stringify({ version: 1 });
	const settingsReads: string[] = [];
	// userData/desktop-update-install.json: written before an install, read once at launch.
	const record = { text: installRecord, removed: false };
	// The session's permission handlers createWindow installs (the last window's).
	const permissions: { request?: (wc: unknown, permission: string, callback: (ok: boolean) => void, details: { requestingUrl?: string }) => void; check?: (wc: unknown, permission: string, origin: string) => boolean } = {};
	const installArgs: unknown[][] = [];
	const order: string[] = [];
	const intervals: { callback: () => void; delay: number }[] = [];
	const timeouts: { callback: () => void; delay: number }[] = [];
	const handles = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
	const windows: FakeWindow[] = [];
	let userData = "/fixture/custom-user-data";
	let menu: { submenu?: { label?: string; click?: () => void | Promise<void> }[] }[] = [];
	// Native dialogs: what each showed (with its parent window, if any) and the buttons to press.
	const dialogs: { parent: unknown; options: { type?: string; title?: string; message: string; detail?: string; buttons: string[]; defaultId?: number; cancelId?: number } }[] = [];
	const answers: number[] = [];
	class FakeUpdater extends EventEmitter {
		checks = 0;
		downloads = 0;
		autoDownload = true;
		autoInstallOnAppQuit = true;
		fullChangelog = false;
		result: object | null = { updateInfo: { version: "0.3.7" } };
		/** A version the feed offers (update-available), or null for none. */
		offer: { version: string; releaseNotes?: unknown } | null = null;
		failure: Error | null = null;
		downloadFails = false;
		checkForUpdates() {
			this.checks++;
			this.emit("checking-for-update");
			if (this.failure) return Promise.reject(this.failure);
			if (this.offer) {
				this.emit("update-available", this.offer);
				return Promise.resolve({ updateInfo: this.offer });
			}
			if (this.result) this.emit("update-not-available", { version: "0.3.7" });
			return Promise.resolve(this.result);
		}
		downloadUpdate() {
			this.downloads++;
			order.push(`download:${this.offer?.version ?? "?"}`);
			if (this.downloadFails) return Promise.reject(new Error("network dropped"));
			this.emit("download-progress", { percent: 50 });
			this.emit("update-downloaded", this.offer ?? { version: "?" });
			return Promise.resolve([]);
		}
		quitAndInstall(...args: unknown[]) { installArgs.push(args); order.push("install"); }
	}
	const updater = new FakeUpdater();
	let nextContentsId = 1;
	class FakeWebContents extends EventEmitter {
		id = nextContentsId++;
		mainFrame = { url: "http://127.0.0.1:9000/" };
		isDestroyed() { return false; }
		messages: { channel: string; value: unknown }[] = [];
		loading = false;
		fails = false;
		send(channel: string, value: unknown) {
			if (this.fails) throw new Error("window destroyed");
			this.messages.push({ channel, value: JSON.parse(JSON.stringify(value)) });
		}
		isLoadingMainFrame() { return this.loading; }
		setWindowOpenHandler() {}
		getZoomFactor() { return 1; }
	}
	class FakeWindow extends EventEmitter {
		webContents = new FakeWebContents();
		minimized = false;
		focused = false;
		constructor() { super(); windows.push(this); }
		loadURL() { this.webContents.loading = true; }
		isMinimized() { return this.minimized; }
		isDestroyed() { return !windows.includes(this); }
		restore() { this.minimized = false; }
		focus() { this.focused = true; }
		show() {}
		close() {
			windows.splice(windows.indexOf(this), 1);
			this.emit("closed");
		}
		static fromWebContents(contents: FakeWebContents) { return windows.find(win => win.webContents === contents); }
		static getAllWindows() { return [...windows]; }
		static getFocusedWindow() { return windows.find(win => win.focused) ?? null; }
	}
	const app = Object.assign(new EventEmitter(), {
		isPackaged: packaged,
		name: "LearnHarness",
		setName() {},
		getPath: () => userData,
		getVersion: () => "0.3.7",
		setPath: (_: string, value: string) => { userData = value; },
		requestSingleInstanceLock: () => false,
		quit() {},
		relaunch() { order.push("relaunch"); },
		exit() { order.push("exit"); },
		whenReady: async () => {},
	});
	const electron = {
		app, BrowserWindow: FakeWindow,
		dialog: {
			showMessageBox: async (...args: unknown[]) => {
				const options = args.at(-1) as (typeof dialogs)[number]["options"];
				dialogs.push({ parent: args.length > 1 ? args[0] : null, options });
				return { response: answers.shift() ?? options.cancelId ?? 0 };
			},
		},
		Menu: { buildFromTemplate: (value: typeof menu) => value, setApplicationMenu: (value: typeof menu) => { menu = value; } },
		ipcMain: { on() {}, handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handles.set(channel, fn) },
		nativeTheme: { shouldUseDarkColors: true, themeSource: "system", on() {} },
		session: { defaultSession: {
			setPermissionRequestHandler(fn: unknown) { permissions.request = fn as typeof permissions.request; },
			setPermissionCheckHandler(fn: unknown) { permissions.check = fn as typeof permissions.check; },
		} },
	};
	const context = createContext({
		require: (id: string) => {
			if (id === "electron") return electron;
			// The actual dev readiness helper is tested separately; keep this
			// updater shell fixture entirely offline and already ready.
			if (id === "./dev-server-readiness.cjs") return { waitForDevServer: async () => {} };
			if (id === "electron-updater") {
				if (updaterMissing) throw new Error("missing updater");
				return { autoUpdater: updater };
			}
			if (id === "node:fs") return {
				readFileSync: (file: string) => {
					if (file.endsWith("desktop-update-install.json")) {
						if (record.text === null) throw new Error("ENOENT");
						return record.text;
					}
					settingsReads.push(file);
					if (settings instanceof Error) throw settings;
					return settings;
				},
				writeFileSync: (file: string, text: string) => { if (file.endsWith("desktop-update-install.json")) { record.text = text; record.removed = false; } },
				rmSync: (file: string) => { if (file.endsWith("desktop-update-install.json")) { record.text = null; record.removed = true; } },
				mkdirSync() {}, appendFileSync() {},
			};
			return mainRequire(id);
		},
		process: { argv: [], env: { LH_DEV_URL: "http://127.0.0.1:9000" }, platform: "darwin", on() {} },
		__dirname: path.dirname(mainFile), URL, AbortController,
		setInterval: (callback: () => void, delay: number) => intervals.push({ callback, delay }),
		setTimeout: (callback: () => void, delay: number) => {
			timeouts.push({ callback, delay });
			return { unref() {} };
		},
		clearTimeout() {},
		fixtureChild: Object.assign(new EventEmitter(), { kill: (signal: string) => order.push(signal) }),
	});
	runInContext(mainSource, context, { filename: mainFile });
	const run = (code: string) => runInContext(code, context);
	return {
		run, updater, windows, intervals, timeouts, handles, settingsReads, order, app, record, installArgs, permissions, dialogs, answers,
		setSettings: (value: unknown) => { settings = JSON.stringify(value); },
		setSettingsFailure: (value: string | Error) => { settings = value; },
		window: () => run("createWindow(process.env.LH_DEV_URL).win") as FakeWindow,
		untrustedWindow: () => new FakeWindow(),
		state: () => JSON.parse(JSON.stringify(run("updateState"))),
		check: async () => { run("checkForUpdates()"); await Promise.resolve(); await Promise.resolve(); },
		menuCheck: () => menu[0]!.submenu!.find(item => item.label === "Check for Updates…")!.click!(),
	};
}

describe("no automatic-update toggle", () => {
	it("a stored autoUpdate: false is ignored: automatic checks run, and main never reads the preference", async () => {
		const f = fixture();
		f.setSettings({ general: { autoUpdate: false } });
		f.run("setupAutoUpdater()");
		await f.check();
		assert.equal(f.updater.checks, 1);
		assert.deepEqual(f.settingsReads, [], "settings.json isn't read for it");
		assert.equal(f.updater.autoDownload, false, "downloads only on click");
		assert.equal(f.updater.autoInstallOnAppQuit, false, "never installs on quit");
		assert.equal(f.updater.fullChangelog, true, "notes for every skipped version");
	});

	it("a stored autoUpdate: false still gets the 15 s startup check and the 4 h one", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
		const settle = () => new Promise((resolve) => setImmediate(resolve));
		f.timeouts.find((t) => t.delay === 15_000)!.callback(); await settle();
		assert.equal(f.updater.checks, 1);
		f.intervals[0]!.callback(); await settle();
		assert.equal(f.updater.checks, 2);
	});

	for (const label of ["unpackaged", "missing updater"] as const) {
		it(`${label} stays unavailable`, async () => {
			const f = fixture({ packaged: label !== "unpackaged", updaterMissing: label === "missing updater" });
			f.run("setupAutoUpdater()"); await f.check(); await f.check();
			assert.equal(f.updater.checks, 0);
			assert.equal(f.settingsReads.length, 0);
			assert.equal(f.state().status, "disabled");
		});
	}
});

describe("status observation never controls the updater", () => {
	it("the local window's notes hold the summary bounds: a long intro never reaches the page", () => {
		const f = fixture(); f.window(); f.run("setupAutoUpdater()");
		const body = `**v0.3.8** · ${"s".repeat(121)}\n\n${"x".repeat(601)}\n\n### Plus 2 more bug fixes.\n\n<details>\n<summary>Full changelog</summary>\n</details>`;
		f.updater.emit("update-available", { version: "0.3.8", releaseNotes: body });
		const [group] = f.state().releaseNotes as Array<Record<string, unknown>>;
		assert.equal(group!.intro, undefined, "601 characters: dropped");
		assert.equal(group!.stats, undefined, "121 characters: dropped");
		assert.equal(group!.footer, "Plus 2 more bug fixes.");
	});

	it("reports events, but a staged update stays visible without suppressing future checks", async () => {
		const f = fixture(); const win = f.window(); f.run("setupAutoUpdater()");
		f.updater.emit("checking-for-update"); assert.equal(f.state().status, "checking");
		f.updater.emit("update-available", { version: "0.3.8", releaseNotes: "- **New.** Thing." });
		assert.equal(f.state().status, "available", "found, not downloaded"); assert.equal(f.state().version, "0.3.8");
		// A plain list (no generated summary) loses its bold, as T3's does; the count comes along.
		assert.deepEqual(f.state().releaseNotes, [{ version: "0.3.8", items: ["New. Thing."], totalItems: 1 }]);
		assert.equal(f.updater.downloads, 0);
		f.updater.emit("checking-for-update"); f.updater.emit("update-not-available", {});
		assert.equal(f.state().status, "available", "a later check keeps the offer on screen");
		f.updater.offer = { version: "0.3.8" };
		await f.run("downloadUpdateNow()");
		assert.equal(f.updater.checks, 1, "Download re-checks first (T3)");
		assert.equal(f.updater.downloads, 1);
		assert.equal(f.state().status, "downloaded");
		assert.deepEqual(f.state().releaseNotes, [{ version: "0.3.8", items: ["New. Thing."], totalItems: 1 }], "notes survive the download");
		f.updater.offer = null;
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		const ready = f.state();
		await f.check();
		f.updater.emit("error", new Error("failure with sensitive diagnostic details"));
		assert.equal(f.updater.checks, 2);
		assert.deepEqual({ ...f.state(), revision: 0, checkedAt: null }, { ...ready, revision: 0, checkedAt: null }, "the staged update stays");
		f.updater.emit("update-downloaded", { version: "0.3.9" });
		assert.equal(f.state().version, "0.3.9");
		assert.ok(f.state().revision > ready.revision);
		assert.equal(win.webContents.messages.at(-1)!.channel, "lh:update-status");
	});

	it("passes the download's percent to the page for the progress ring: 0 at the start, then each whole 10% (T3's rule)", async () => {
		const f = fixture(); const win = f.window(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		assert.equal(f.state().downloadPercent, null, "not downloading");
		f.updater.downloadUpdate = () => new Promise<never[]>(() => {});
		f.updater.offer = { version: "0.3.8" };
		void f.run("downloadUpdateNow()");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(f.state().status, "downloading");
		assert.equal(f.state().downloadPercent, 0);
		const pushes = () => win.webContents.messages.filter((m) => m.channel === "lh:update-status").length;
		const before = pushes();
		const seen: unknown[] = [];
		for (const percent of [3.2, 9.9, 12.5, 19, 47.1, 100]) {
			f.updater.emit("download-progress", { percent, transferred: 0, total: 1, bytesPerSecond: 1 });
			seen.push(f.state().downloadPercent);
		}
		assert.deepEqual(seen, [0, 0, 12.5, 12.5, 47.1, 100]);
		assert.equal(pushes() - before, 3, "a push per step, not per event");
		assert.equal((win.webContents.messages.at(-1)!.value as { downloadPercent: number }).downloadPercent, 100);
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		assert.equal(f.state().status, "downloaded");
		assert.equal(f.state().downloadPercent, 100, "T3's downloaded state reads 100");
	});

	it("Update everything's pinned download also reports 0 at the start", () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		f.updater.downloadUpdate = () => new Promise<never[]>(() => {});
		void f.run(`updateActions.downloadPinned("0.3.8")`);
		assert.equal(f.state().status, "downloading");
		assert.equal(f.state().downloadPercent, 0);
	});

	for (const status of ["checking", "downloading", "error", "disabled", "downloaded"]) {
		it(`a ${status} display state does not block a future automatic check`, async () => {
			const f = fixture(); f.run(`setupAutoUpdater(); setUpdateState({ ...updateState, status: "${status}" })`); await f.check();
			assert.equal(f.updater.checks, 1);
		});
	}

	it("check failures settle to a generic error and later checks still run", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.failure = new Error("private endpoint/diagnostic detail"); await f.check();
		assert.equal(f.state().status, "error");
		assert.ok(!JSON.stringify(f.state()).includes("private"));
		f.updater.failure = null; await f.check();
		assert.equal(f.updater.checks, 2); assert.equal(f.state().status, "up-to-date");
	});

	it("a declined check makes no up-to-date claim", async () => {
		const f = fixture(); f.updater.result = null; f.run("setupAutoUpdater()"); await f.check();
		assert.equal(f.state().status, "idle");
	});

	it("a local send failure does not block the next local window, and untrusted windows receive no update IPC", async () => {
		const f = fixture(); const bad = f.window(); bad.webContents.fails = true; const good = f.window();
		const remote = f.untrustedWindow();
		f.run("setupAutoUpdater()"); await f.check();
		assert.equal(good.webContents.messages.at(-1)!.channel, "lh:update-status");
		assert.deepEqual(remote.webContents.messages, []);
		await f.check();
		assert.equal(f.updater.checks, 2);
	});

	it("Install re-checks, then kills the server before installing", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		assert.equal(f.state().status, "downloaded"); assert.equal(f.updater.checks, 0);
		f.updater.offer = { version: "0.3.8" };
		await f.run("serverProcess = fixtureChild; installUpdateNow()");
		assert.equal(f.updater.checks, 1, "Install re-checks first");
		assert.deepEqual(f.order, ["SIGTERM", "install"], "the same version is not downloaded again");
	});

	it("Install takes a newer build published since the download", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		f.updater.offer = { version: "0.3.9", releaseNotes: "- newer" };
		await f.run("serverProcess = fixtureChild; installUpdateNow()");
		assert.deepEqual(f.order, ["download:0.3.9", "SIGTERM", "install"]);
		assert.equal(f.state().version, "0.3.9");
	});

	it("a failed newer download installs nothing and offers the newer build again", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		f.updater.offer = { version: "0.3.9" }; f.updater.downloadFails = true;
		await f.run("serverProcess = fixtureChild; installUpdateNow()");
		assert.deepEqual(f.order, ["download:0.3.9"], "the server keeps running and nothing installs");
		assert.equal(f.state().status, "available"); assert.equal(f.state().version, "0.3.9");
		assert.equal(f.state().errorContext, "download", "T3's download-failed retry");
		f.updater.downloadFails = false;
		await f.run("downloadUpdateNow()");
		assert.equal(f.state().status, "downloaded", "retry works");
	});

	it("an install that never quits relaunches the app on the current version", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		await f.run("serverProcess = fixtureChild; installUpdateNow()");
		const grace = f.timeouts.find((t) => t.delay === 10_000);
		assert.ok(grace, "a quit grace timer is armed");
		grace.callback();
		assert.deepEqual(f.order, ["SIGTERM", "install", "relaunch", "exit"]);
	});

	it("a failed re-check still installs the downloaded build; nothing installs without a download", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		await f.run("installUpdateNow()");
		assert.deepEqual(f.order, [], "nothing downloaded: no install");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		f.updater.failure = new Error("offline");
		await f.run("serverProcess = fixtureChild; installUpdateNow()");
		assert.deepEqual(f.order, ["SIGTERM", "install"]);
	});

	it("installs silently and runs the new version after (T3's quitAndInstall), recording which install it started", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		await f.run("serverProcess = fixtureChild; installUpdateNow()");
		assert.deepEqual(f.installArgs, [[true, true]], "isSilent, isForceRunAfter");
		assert.deepEqual(JSON.parse(f.record.text!), { fromVersion: "0.3.7", targetVersion: "0.3.8" });
	});

	it("a launch still on the old version says the install did not apply; one on the new version clears the record", () => {
		const stuck = fixture({ installRecord: JSON.stringify({ fromVersion: "0.3.7", targetVersion: "0.3.8" }) });
		stuck.run("setupAutoUpdater()");
		stuck.updater.emit("update-available", { version: "0.3.8" });
		assert.equal(stuck.state().notAppliedVersion, "0.3.8");
		assert.equal(stuck.record.removed, false, "kept until it applies");
		const applied = fixture({ installRecord: JSON.stringify({ fromVersion: "0.3.6", targetVersion: "0.3.7" }) });
		applied.run("setupAutoUpdater()");
		applied.updater.emit("update-available", { version: "0.3.8" });
		assert.equal(applied.state().notAppliedVersion, undefined);
		assert.equal(applied.record.removed, true);
	});

	it("a failed check carries T3's fields with a fixed message; a failed download keeps the offer to retry", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.failure = new Error("https://private.example/feed 500"); await f.check();
		await new Promise((resolve) => setImmediate(resolve));
		const failed = f.state();
		assert.deepEqual([failed.status, failed.errorContext, failed.canRetry, failed.message], ["error", "check", true, "Couldn’t check for updates. Try again later."]);
		assert.ok(typeof failed.checkedAt === "string" && !JSON.stringify(failed).includes("private"));
		f.updater.failure = null;
		f.updater.emit("update-available", { version: "0.3.8" });
		f.updater.offer = { version: "0.3.8" }; f.updater.downloadFails = true;
		await f.run("downloadUpdateNow()");
		const retry = f.state();
		assert.deepEqual([retry.status, retry.errorContext, retry.canRetry, retry.availableVersion, retry.message], ["available", "download", true, "0.3.8", "Couldn’t download the update. Try again."]);
		assert.ok(!JSON.stringify(retry).includes("network dropped"));
	});

	it("Download re-checks first and takes a newer build the feed offers since", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		f.updater.offer = { version: "0.3.9" };
		await f.run("downloadUpdateNow()");
		assert.equal(f.updater.checks, 1);
		assert.deepEqual(f.order, ["download:0.3.9"]);
		assert.deepEqual([f.state().status, f.state().downloadedVersion], ["downloaded", "0.3.9"]);
		// A failed re-check still downloads the known offer.
		const g = fixture(); g.run("setupAutoUpdater()");
		g.updater.emit("update-available", { version: "0.3.8" });
		g.updater.failure = new Error("offline"); g.updater.offer = { version: "0.3.8" };
		await g.run("downloadUpdateNow()");
		assert.equal(g.updater.downloads, 1);
	});

	it("an installer error after quitAndInstall recovers as T3's does: still downloaded, Install works again, the server restarts", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.run("var fixtureRestarts = 0; restartLocalAfterFailedInstall = async () => { fixtureRestarts++; }");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		f.updater.failure = new Error("offline");
		await f.run("serverProcess = fixtureChild; installUpdateNow()");
		assert.ok(f.record.text, "the install record was written");
		f.updater.emit("error", new Error("installer refused"));
		const failed = f.state();
		assert.deepEqual([failed.status, failed.errorContext, failed.canRetry, failed.downloadedVersion, failed.message], ["downloaded", "install", true, "0.3.8", "Couldn’t install the update."], "T3's install failure, with no generic error on top");
		assert.equal(f.record.text, null, "never applied: the record goes");
		assert.equal(f.run("installing"), false, "the install flags reset");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(f.run("fixtureRestarts"), 0, "not while the old server is still stopping (its close would dispose the new backend)");
		f.run("fixtureChild.emit('close', 0, null)");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(f.run("fixtureRestarts"), 1, "the bundled server stopped for the install starts again once it stopped");
		f.updater.emit("error", new Error("a later background error"));
		assert.equal(f.state().status, "downloaded", "a later error doesn't hide it");
		// Install again works, and the failure no longer applies.
		f.updater.failure = null;
		f.run("fixtureChild.removeAllListeners('close')");
		await f.run("serverProcess = fixtureChild; installUpdateNow()");
		assert.deepEqual(f.installArgs, [[true, true], [true, true]]);
		assert.equal(f.state().errorContext, null);
		// An error from Install's own re-check is not an install failure.
		const g = fixture(); g.run("setupAutoUpdater()");
		g.updater.emit("update-downloaded", { version: "0.3.8" });
		g.updater.checkForUpdates = function () { this.checks++; this.emit("error", new Error("feed down")); return Promise.reject(new Error("feed down")); };
		await g.run("serverProcess = fixtureChild; installUpdateNow()");
		assert.deepEqual([g.state().status, g.state().errorContext], ["downloaded", null], "the re-check's error is not an install failure");
		assert.deepEqual(g.installArgs, [[true, true]]);
	});

	it("after a failed install the local window reloads through its own load(): permissions and navigation follow the new port", async () => {
		const f = fixture(); const win = f.window();
		const loaded: string[] = [];
		const original = win.loadURL.bind(win);
		win.loadURL = ((url: string) => { loaded.push(url); original(); }) as typeof win.loadURL;
		f.run("startLocalServer = async () => { localOrigin = 'http://127.0.0.1:9555'; desktopSessionToken = 'session-token'; return 'http://127.0.0.1:9555'; }");
		await f.run("restartLocalAfterFailedInstall()");
		assert.deepEqual(loaded, ["about:blank", "http://127.0.0.1:9555"]);
		assert.equal(f.permissions.check!(null, "media", "http://127.0.0.1:9555"), true, "the new origin's permissions");
		assert.equal(f.permissions.check!(null, "media", "http://127.0.0.1:9000"), false, "not the old one's");
		let prevented = false;
		win.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, "http://127.0.0.1:9555/chat");
		assert.equal(prevented, false, "same-origin navigation on the new port stays in the window");
	});

	it("the reloaded window's first request to the new server carries the desktop session, as at launch (no Pair this device)", async () => {
		const f = fixture(); const win = f.window();
		// The window shows the old port's page; the navigation's request asks for the bearer at load time.
		win.webContents.mainFrame.url = "http://127.0.0.1:9000/chat";
		const bearers: unknown[] = [];
		win.loadURL = ((url: string) => {
			if (url !== "about:blank") {
				const headers = f.run(`desktopAPIHeaders({ url: ${JSON.stringify(url)}, requestHeaders: {}, webContentsId: [...trustedAppWindows][0].webContents.id, webContents: [...trustedAppWindows][0].webContents, frame: [...trustedAppWindows][0].webContents.mainFrame }, localOrigin, desktopSessionToken, [...trustedAppWindows])`) as Record<string, string>;
				bearers.push(headers.authorization);
			}
			win.webContents.mainFrame.url = url;
		}) as typeof win.loadURL;
		f.run("startLocalServer = async () => { localOrigin = 'http://127.0.0.1:9555'; desktopSessionToken = 'session-token'; return 'http://127.0.0.1:9555'; }");
		await f.run("restartLocalAfterFailedInstall()");
		assert.deepEqual(bearers, ["Bearer session-token"]);
		// And nothing loads before the server has its desktop session.
		const g = fixture(); const other = g.window();
		const otherLoads: string[] = [];
		other.loadURL = ((url: string) => { otherLoads.push(url); }) as typeof other.loadURL;
		g.run("startLocalServer = async () => { localOrigin = null; desktopSessionToken = null; return 'http://127.0.0.1:9556'; }");
		await assert.rejects(g.run("restartLocalAfterFailedInstall()") as Promise<void>, /no desktop session/);
		assert.deepEqual(otherLoads, []);
	});

	it("an offer that isn't downloaded stays on screen through a failed background check, notes and all", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8", releaseNotes: "- A change" });
		const offered = f.state();
		f.updater.failure = new Error("offline");
		await f.check();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual([f.state().status, f.state().availableVersion], ["available", "0.3.8"]);
		assert.deepEqual(f.state().releaseNotes, offered.releaseNotes);
		await (f.run("updateActions.checkNatively()") as Promise<void>).catch(() => {});
		assert.equal(f.state().status, "available", "the menu's failed check too");
	});

	it("a failed pinned install ends the Update everything run instead of leaving it on Restarting", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.run("var fixtureRunEnded = 0; updateEverything = { running: () => false, installFailed: () => { fixtureRunEnded++; } }");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		f.run(`updateActions.installPinned("0.3.8")`);
		f.updater.emit("error", new Error("installer refused"));
		assert.equal(f.run("fixtureRunEnded"), 1);
		assert.equal(f.state().errorContext, "install");
	});

	it("no check runs while an install is under way, so a feed error can't read as the install's", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		f.updater.quitAndInstall = function (...args: unknown[]) { f.installArgs.push(args); };
		await f.run("installUpdateNow()");
		const checks = f.updater.checks;
		f.updater.failure = new Error("feed down");
		await f.check();
		f.intervals.forEach((t) => t.callback());
		await f.run("updateActions.checkNatively()");
		assert.equal(f.updater.checks, checks, "the timer, Settings and the menu all wait");
		assert.equal(f.state().status, "downloaded", "and nothing recovered");
		assert.equal(f.run("installing"), true);
	});

	it("a retry from error whose re-check fails downloads the known offer, never sticking on Checking", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		f.updater.offer = { version: "0.3.8" }; f.updater.downloadFails = true;
		await f.run("downloadUpdateNow()");
		f.updater.emit("error", new Error("background"));
		assert.deepEqual([f.state().status, f.state().errorContext], ["error", "download"]);
		f.updater.failure = new Error("offline"); f.updater.downloadFails = false;
		const statuses: string[] = [];
		f.updater.on("checking-for-update", () => statuses.push(f.state().status));
		await f.run("downloadUpdateNow()");
		assert.deepEqual(statuses, ["error"], "the retry's re-check doesn't flip it to Checking");
		assert.equal(f.state().status, "downloaded");
	});

	it("the menu's failed check never replaces a download under way", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		f.run("setUpdateState(updateMachine.reduceOnDownloadStart(updateState))");
		f.updater.failure = new Error("feed down");
		await (f.run("updateActions.checkNatively()") as Promise<void>).catch(() => {});
		assert.equal(f.state().status, "downloading");
	});

	it("a Download click during a running check waits for it, then downloads (T3's admitAfterCheck)", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		let finish!: () => void;
		const original = f.updater.checkForUpdates.bind(f.updater);
		f.updater.checkForUpdates = function () { this.checks++; this.emit("checking-for-update"); return new Promise((resolve) => { finish = () => resolve({ updateInfo: { version: "0.3.8" } }); }); };
		f.run("checkForUpdates()");
		const clicked = f.run("downloadUpdateNow()") as Promise<void>;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(f.updater.downloads, 0, "waits while the check runs");
		f.updater.checkForUpdates = original;
		f.updater.offer = { version: "0.3.8" };
		finish();
		await clicked;
		assert.equal(f.updater.downloads, 1, "then downloads, not dropped");
	});

	it("Download's re-check acts on its own result: a release pulled from the feed clears the offer and downloads nothing", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		f.updater.offer = null;
		await f.run("downloadUpdateNow()");
		assert.equal(f.updater.downloads, 0);
		assert.deepEqual([f.state().status, f.state().availableVersion], ["up-to-date", null], "T3's no-update state");
	});

	it("a failed download that an updater error moved to error still retries from the button (never a dead click)", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		f.updater.offer = { version: "0.3.8" }; f.updater.downloadFails = true;
		await f.run("downloadUpdateNow()");
		f.updater.emit("error", new Error("background"));
		assert.deepEqual([f.state().status, f.state().errorContext, f.state().availableVersion], ["error", "download", "0.3.8"]);
		f.updater.downloadFails = false;
		await f.run("downloadUpdateNow()");
		assert.equal(f.state().status, "downloaded", "the retry downloads");
	});

	it("a failed background check doesn't replace a download under way", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		f.run("setUpdateState(updateMachine.reduceOnDownloadStart(updateState))");
		f.updater.failure = new Error("offline"); await f.check();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(f.state().status, "downloading");
	});

	it("a pinned download (Update everything) over a staged older one names its version, and its failure leaves nothing stuck", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		f.updater.offer = { version: "0.3.9" }; f.updater.downloadFails = true;
		const pinned = f.run(`updateActions.downloadPinned("0.3.9")`) as Promise<void>;
		assert.deepEqual([f.state().status, f.state().version, f.state().downloadedVersion], ["downloading", "0.3.9", null], "the ring and the menu name 0.3.9");
		await assert.rejects(pinned);
		assert.deepEqual([f.state().status, f.state().availableVersion, f.state().errorContext], ["available", "0.3.9", "download"], "offered again with T3's retry");
		f.updater.downloadFails = false;
		await f.run("downloadUpdateNow()");
		assert.deepEqual([f.state().status, f.state().downloadedVersion], ["downloaded", "0.3.9"], "and Download works");
	});

	it("a downgrade below the record's starting version clears it, so it never revives did not apply", () => {
		const f = fixture({ installRecord: JSON.stringify({ fromVersion: "0.3.8", targetVersion: "0.3.9" }) });
		f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.9" });
		assert.equal(f.state().notAppliedVersion, undefined);
		assert.equal(f.record.removed, true);
	});

	it("the check and Download IPC resolve T3's results with the state, for the sidebar's toasts", async () => {
		const f = fixture(); await f.run("main()");
		const sender = f.windows[0]!.webContents;
		const event = { sender, senderFrame: sender.mainFrame };
		const check = f.handles.get("lh:update:check")!;
		const ran = await check(event) as { checked: boolean; state: { status: string } };
		assert.deepEqual([ran.checked, ran.state.status], [true, "up-to-date"]);
		f.updater.failure = new Error("https://private.example 500");
		const failed = await check(event) as { checked: boolean; state: { status: string; message: string } };
		assert.deepEqual([failed.checked, failed.state.status], [true, "error"], "it ran; the state says how it went");
		assert.ok(!JSON.stringify(failed).includes("private"));
		f.updater.failure = null;
		const download = f.handles.get("lh:update:download")!;
		const refused = await download(event) as { accepted: boolean; completed: boolean; state: { status: string } };
		assert.deepEqual([refused.accepted, refused.completed, refused.state.status], [false, false, "error"], "nothing offered: refused, with the state");
		f.updater.emit("update-available", { version: "0.3.8" });
		f.updater.offer = { version: "0.3.8" }; f.updater.downloadFails = true;
		const failedDownload = await download(event) as { accepted: boolean; completed: boolean; state: { message: string } };
		assert.deepEqual([failedDownload.accepted, failedDownload.completed, failedDownload.state.message], [true, false, "Couldn’t download the update. Try again."]);
		f.updater.downloadFails = false;
		const done = await download(event) as { accepted: boolean; completed: boolean; state: { status: string } };
		assert.deepEqual([done.accepted, done.completed, done.state.status], [true, true, "downloaded"]);
		const none = fixture({ updaterMissing: true }); await none.run("main()");
		const noneSender = none.windows[0]!.webContents;
		assert.equal((await none.handles.get("lh:update:check")!({ sender: noneSender, senderFrame: noneSender.mainFrame }) as { checked: boolean }).checked, false, "no updater: no check ran");
	});

	it("main owns once per launch in two steps: a visible page claims (reserves), shows, then acks; a page that goes first gives it back", async () => {
		const f = fixture({ installRecord: JSON.stringify({ fromVersion: "0.3.7", targetVersion: "0.3.8" }) }); await f.run("main()");
		const sender = f.windows[0]!.webContents;
		const event = { sender, senderFrame: sender.mainFrame };
		const claim = f.handles.get("lh:update:claim-notice")!;
		const ack = f.handles.get("lh:update:ack-notice")!;
		assert.equal(f.state().notAppliedVersion, "0.3.8", "in the first snapshot, before any check");
		assert.equal((f.handles.get("lh:update:get")!(event) as { notAppliedVersion?: string }).notAppliedVersion, "0.3.8");
		assert.equal(await claim(event, "not-applied:0.3.9"), false, "not the version the state carries");
		for (const bad of ["install-failed:1", "anything", 7, "not-applied:../x"]) assert.equal(await claim(event, bad), false);
		assert.throws(() => claim({ sender: {}, senderFrame: sender.mainFrame }, "not-applied:0.3.8"), /Untrusted/);
		// Another window's page, reserving before the first page shows it.
		const otherWin = f.run("createWindow(process.env.LH_DEV_URL).win") as { webContents: typeof sender };
		const otherEvent = { sender: otherWin.webContents, senderFrame: otherWin.webContents.mainFrame };
		assert.equal(await claim(event, "not-applied:0.3.8"), true, "reserved for this page");
		assert.equal(await claim(otherEvent, "not-applied:0.3.8"), false, "not while another page holds it");
		// The first page reloads (or closes) before showing it: its reservation goes back.
		sender.emit("did-start-navigation");
		assert.equal(await claim(otherEvent, "not-applied:0.3.8"), true, "the other page may take it now");
		assert.equal(await ack(event, "not-applied:0.3.8"), false, "only the holder acks");
		assert.equal(await ack(otherEvent, "not-applied:0.3.8"), true, "shown");
		assert.equal(await claim(event, "not-applied:0.3.8"), false, "never again this launch");
		assert.equal(await claim(otherEvent, "not-applied:0.3.8"), false);
	});

	it("a window still on the last local origin claims after the server's restart failed (localOrigin cleared)", async () => {
		const f = fixture({ installRecord: JSON.stringify({ fromVersion: "0.3.7", targetVersion: "0.3.8" }) }); await f.run("main()");
		const sender = f.windows[0]!.webContents;
		const origin = new URL(sender.mainFrame.url).origin;
		f.run(`lastLocalOrigin = ${JSON.stringify(origin)}; localOrigin = null`);
		assert.equal(await f.handles.get("lh:update:claim-notice")!({ sender, senderFrame: sender.mainFrame }, "not-applied:0.3.8"), true);
	});

	it("only an install the sidebar started becomes the notice, once its server's windows reloaded, with its fixed text; it goes with the next state change", async () => {
		const settle = () => new Promise((resolve) => setImmediate(resolve));
		const f = fixture(); f.run("setupAutoUpdater()");
		f.run("var fixtureReload; restartLocalAfterFailedInstall = () => new Promise((resolve) => { fixtureReload = resolve; })");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		f.updater.failure = new Error("offline");
		await f.run("serverProcess = fixtureChild; installUpdateNow({ fromSidebar: true })");
		f.updater.emit("error", new Error("installer refused"));
		f.run("fixtureChild.emit('close', 0, null)");
		await settle();
		assert.equal(f.state().installFailedNotice, undefined, "not before the reload: that page goes");
		f.run("fixtureReload()");
		await settle();
		assert.deepEqual([f.state().installFailedNotice, f.state().installFailedNoticeMessage], [1, "Couldn’t install the update."], "the reloaded page reads it, with its fixed text");
		const page = {}; // a page's webContents, as main sees it
		assert.equal(f.run("claimUpdateNotice")("install-failed:1", page), true);
		assert.equal(f.run("ackUpdateNotice")("install-failed:1", page), true);
		assert.equal(f.run("claimUpdateNotice")("install-failed:1", page), false);
		// A later state change: no longer current, so no page shows it later.
		f.updater.failure = null;
		f.updater.emit("checking-for-update"); f.updater.emit("update-not-available", {});
		f.run("setUpdateState(updateMachine.reduceOnCheckFailure(updateState, 'x', 'now'))");
		assert.equal(f.state().installFailedNotice, undefined);
		// Settings' Install (no sidebar source), Update everything (installPinned) and the menu raise none.
		for (const start of ["installUpdateNow()", "updateActions.installPinned('0.3.8')"]) {
			const g = fixture(); g.run("setupAutoUpdater()");
			g.updater.emit("update-downloaded", { version: "0.3.8" });
			g.updater.failure = new Error("offline");
			await g.run(start);
			g.updater.emit("error", new Error("installer refused"));
			await settle();
			assert.deepEqual([g.state().errorContext, g.state().installFailedNotice], ["install", undefined], start);
		}
		// No server to restart: the sidebar's notice comes at once.
		const h = fixture(); h.run("setupAutoUpdater()");
		h.updater.emit("update-downloaded", { version: "0.3.8" });
		h.updater.failure = new Error("offline");
		await h.run("installUpdateNow({ fromSidebar: true })");
		h.updater.emit("error", new Error("installer refused"));
		assert.equal(h.state().installFailedNotice, 1);
	});

	it("Install from the sidebar whose newer download fails says so with the download's fixed text (T3's installLocalUpdate)", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		f.updater.offer = { version: "0.3.9" }; f.updater.downloadFails = true;
		await f.run("serverProcess = fixtureChild; installUpdateNow({ fromSidebar: true })");
		assert.deepEqual([f.state().status, f.state().installFailedNotice, f.state().installFailedNoticeMessage], ["available", 1, "Couldn’t download the update. Try again."]);
		const g = fixture(); g.run("setupAutoUpdater()");
		g.updater.emit("update-downloaded", { version: "0.3.8" });
		g.updater.offer = { version: "0.3.9" }; g.updater.downloadFails = true;
		await g.run("serverProcess = fixtureChild; installUpdateNow()");
		assert.equal(g.state().installFailedNotice, undefined, "not from Settings");
	});

	it("Install is a trusted IPC call that answers whether main took it", async () => {
		const f = fixture(); await f.run("main()");
		const sender = f.windows[0]!.webContents;
		const install = f.handles.get("lh:update-install")!;
		assert.equal(install({ sender, senderFrame: sender.mainFrame }), false, "nothing staged");
		assert.throws(() => install({ sender: {}, senderFrame: sender.mainFrame }), /Untrusted/);
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		f.run("updateEverything = { running: () => true }");
		assert.equal(install({ sender, senderFrame: sender.mainFrame }), false, "an Update everything run owns the updater");
		assert.equal(f.updater.checks, 0, "and nothing started");
		f.run("updateEverything = null");
		assert.equal(install({ sender, senderFrame: sender.mainFrame }), true);
	});

	it("Download is a trusted IPC call and only acts on an offered version", async () => {
		const f = fixture(); await f.run("main()");
		const sender = f.windows[0]!.webContents;
		const download = f.handles.get("lh:update:download")!;
		await download({ sender, senderFrame: sender.mainFrame });
		assert.equal(f.updater.downloads, 0, "nothing offered yet");
		f.updater.emit("update-available", { version: "0.3.8" });
		assert.throws(() => download({ sender: {}, senderFrame: sender.mainFrame }), /Untrusted/);
		f.updater.offer = { version: "0.3.8" };
		await download({ sender, senderFrame: sender.mainFrame });
		assert.equal(f.updater.downloads, 1);
	});
});

/** The menu's click starts async work (its check, its dialog): let it run out. */
const settleMenu = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

describe("startup, timer, trusted IPC and menu wiring", () => {
	it("starts and retains the 4h timer without any Settings subscription", async () => {
		const f = fixture();
		await f.run("main()");
		assert.equal(f.updater.checks, 0);
		assert.equal(f.intervals.length, 1); assert.equal(f.intervals[0]!.delay, 4 * 60 * 60 * 1000);
		// Each check settles before the next one (a check of ours still running skips another, as T3's does).
		const settle = () => new Promise((resolve) => setImmediate(resolve));
		f.intervals[0]!.callback(); await settle();
		assert.equal(f.updater.checks, 1);
		f.windows[0]!.close(); f.intervals[0]!.callback(); await settle();
		assert.equal(f.updater.checks, 2, "checks also work with every window closed");
	});

	it("ON/default boot checks 15 s after launch and status never disables the scheduled check", async () => {
		const f = fixture(); f.setSettings({ version: 1 }); await f.run("main()");
		assert.equal(f.updater.checks, 0, "not at launch");
		const first = f.timeouts.find((t) => t.delay === 15_000);
		assert.ok(first, "a 15 s startup check is scheduled");
		const settle = () => new Promise((resolve) => setImmediate(resolve));
		first.callback(); await settle();
		assert.equal(f.updater.checks, 1);
		f.run('setUpdateState(updateMachine.reduceOnDownloadStart(updateState))'); f.intervals[0]!.callback(); await settle();
		assert.equal(f.updater.checks, 2, "a downloading display state doesn't block it");
	});

	it("snapshot/manual IPC accepts only an owned main frame and snapshot reads never check", async () => {
		const f = fixture(); await f.run("main()");
		const sender = f.windows[0]!.webContents;
		const event = { sender, senderFrame: sender.mainFrame };
		const get = f.handles.get("lh:update:get")!; const check = f.handles.get("lh:update:check")!;
		assert.equal((get(event) as { status: string }).status, "idle"); assert.equal(f.updater.checks, 0);
		check(event); assert.equal(f.updater.checks, 1);
		for (const bad of [
			{ sender: {}, senderFrame: sender.mainFrame },
			{ sender, senderFrame: { url: sender.mainFrame.url } },
		]) {
			assert.throws(() => get(bad), /Untrusted/); assert.throws(() => check(bad), /Untrusted/);
		}
		sender.mainFrame.url = "https://untrusted.invalid/";
		assert.throws(() => check(event), /Untrusted/);
		assert.equal(f.updater.checks, 1);
	});

	it("the menu restores and focuses the window first, then shows T3's dialog over it, and never opens Settings", async () => {
		const f = fixture(); await f.run("main()");
		const win = f.windows[0]!; win.minimized = true;
		await f.menuCheck();
		await settleMenu();
		assert.deepEqual([win.minimized, win.focused], [false, true]);
		assert.equal(f.updater.checks, 1, "main's own check");
		assert.deepEqual(f.dialogs.map((d) => [d.options.title, d.options.message, d.options.buttons]), [["You're up to date!", "LearnHarness 0.3.7 is currently the newest version available.", ["OK"]]]);
		assert.equal(f.dialogs[0]!.parent, win, "over the app's window");
		assert.deepEqual(win.webContents.messages.filter((message) => !message.channel.startsWith("lh:update")), [], "no Settings page: the dialog is the answer");
		assert.equal(f.state().status, "up-to-date", "the sidebar and Settings follow the same state");
	});

	it("the menu reopens a window when none is open, then shows its dialog", async () => {
		const f = fixture(); await f.run("main()");
		f.windows[0]!.close();
		await f.menuCheck();
		await settleMenu();
		assert.equal(f.windows.length, 1);
		assert.equal(f.dialogs[0]!.options.title, "You're up to date!");
	});

	it("Update available → Download downloads through main's Download (the sidebar's), with no toast notice", async () => {
		const f = fixture(); await f.run("main()");
		f.updater.offer = { version: "0.3.8" };
		f.answers.push(0);
		await f.menuCheck();
		await settleMenu();
		assert.deepEqual([f.dialogs[0]!.options.title, f.dialogs[0]!.options.message, f.dialogs[0]!.options.detail, f.dialogs[0]!.options.buttons], ["Update available", "LearnHarness 0.3.8 is available.", "You're running LearnHarness 0.3.7.", ["Download", "Later"]]);
		assert.deepEqual([f.dialogs[0]!.options.defaultId, f.dialogs[0]!.options.cancelId], [0, 1]);
		assert.equal(f.updater.downloads, 1);
		assert.equal(f.state().status, "downloaded");
		assert.equal(f.state().installFailedNotice, undefined);
		// Later downloads nothing.
		const later = fixture(); await later.run("main()");
		later.updater.offer = { version: "0.3.8" };
		later.answers.push(1);
		await later.menuCheck();
		await settleMenu();
		assert.equal(later.updater.downloads, 0);
		assert.equal(later.state().status, "available");
	});

	it("Update ready → Restart installs through main's Install: the install record, then quitAndInstall(true, true)", async () => {
		const f = fixture(); await f.run("main()");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		f.answers.push(0);
		await f.menuCheck();
		await settleMenu();
		assert.deepEqual([f.dialogs[0]!.options.title, f.dialogs[0]!.options.message, f.dialogs[0]!.options.detail, f.dialogs[0]!.options.buttons], ["Update ready", "LearnHarness 0.3.8 is ready to install.", "LearnHarness will restart to install it. Any running tasks will be interrupted.", ["Restart", "Later"]]);
		assert.deepEqual(f.installArgs, [[true, true]]);
		assert.deepEqual(JSON.parse(f.record.text!), { fromVersion: "0.3.7", targetVersion: "0.3.8" });
		assert.equal(f.run("installNotifies"), false, "a failure later is no sidebar notice (no toast)");
		const later = fixture(); await later.run("main()");
		later.updater.emit("update-downloaded", { version: "0.3.8" });
		later.answers.push(1);
		await later.menuCheck();
		await settleMenu();
		assert.deepEqual(later.installArgs, [], "Later installs nothing");
	});

	it("mid-download: Update downloading, with no second download or check", async () => {
		const f = fixture(); await f.run("main()");
		f.updater.offer = { version: "0.3.8" };
		await f.run("checkForUpdates()");
		let finish!: () => void;
		f.updater.downloadUpdate = function () { this.downloads++; return new Promise<never[]>((resolve) => { finish = () => { this.emit("update-downloaded", { version: "0.3.8" }); resolve([]); }; }); };
		const downloading = f.run("downloadUpdateNow()") as Promise<unknown>;
		await settleMenu();
		const checks = f.updater.checks;
		await f.menuCheck();
		await settleMenu();
		assert.deepEqual([f.dialogs[0]!.options.title, f.dialogs[0]!.options.message, f.dialogs[0]!.options.buttons], ["Update downloading", "LearnHarness 0.3.8 is already downloading.", ["OK"]]);
		assert.deepEqual([f.updater.checks, f.updater.downloads], [checks, 1], "the menu's check didn't run beside the download");
		finish(); await downloading;
	});

	it("a failed check: Update check failed with main's fixed line, never the updater's error", async () => {
		const f = fixture(); await f.run("main()");
		f.updater.failure = new Error("https://private.example/feed 500");
		await f.menuCheck();
		await settleMenu();
		assert.deepEqual([f.dialogs[0]!.options.type, f.dialogs[0]!.options.title, f.dialogs[0]!.options.message, f.dialogs[0]!.options.detail], ["warning", "Update check failed", "Could not check for updates.", "Couldn’t check for updates. Try again later."]);
		assert.ok(!JSON.stringify(f.dialogs).includes("private.example"));
	});

	it("during an Update everything run: Update in progress, no check; a run that starts while a dialog is open stops its button", async () => {
		const f = fixture(); await f.run("main()");
		f.run("updateEverything = { running: () => true, server: () => null }");
		await f.menuCheck();
		await settleMenu();
		assert.deepEqual([f.dialogs[0]!.options.title, f.dialogs[0]!.options.message], ["Update in progress", "Update everything is running."]);
		assert.equal(f.updater.checks, 0);
		const g = fixture(); await g.run("main()");
		g.updater.emit("update-downloaded", { version: "0.3.8" });
		g.run("var fixtureRun = false; updateEverything = { running: () => fixtureRun, server: () => null }");
		let answer!: (value: { response: number }) => void;
		g.run("dialog").showMessageBox = () => new Promise((resolve) => { answer = resolve; });
		const clicked = g.menuCheck();
		await settleMenu();
		g.run("fixtureRun = true");
		answer({ response: 0 });
		await clicked; await settleMenu();
		assert.deepEqual(g.installArgs, [], "Restart does nothing once a run owns the updater");
	});

	it("unpackaged: Updates unavailable, before any window opens or check runs", async () => {
		const f = fixture({ packaged: false }); await f.run("main()");
		f.windows[0]!.close();
		await f.menuCheck();
		await settleMenu();
		assert.deepEqual([f.dialogs[0]!.options.title, f.dialogs[0]!.options.message, f.dialogs[0]!.options.detail], ["Updates unavailable", "Automatic updates are not available right now.", "Automatic updates are not available in this build."]);
		assert.equal(f.windows.length, 0, "no window reopened for it");
	});

	it("while an install is under way the menu shows nothing and checks nothing", async () => {
		const f = fixture(); await f.run("main()");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		await f.run("installUpdateNow()");
		const checks = f.updater.checks;
		await f.menuCheck();
		await settleMenu();
		assert.deepEqual([f.dialogs.length, f.updater.checks], [0, checks]);
	});
});
