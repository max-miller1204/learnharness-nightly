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
	let settings: string | Error = JSON.stringify({ version: 1, general: { autoUpdate: true } });
	const settingsReads: string[] = [];
	// userData/desktop-update-install.json: written before an install, read once at launch.
	const record = { text: installRecord, removed: false };
	const installArgs: unknown[][] = [];
	const order: string[] = [];
	const intervals: { callback: () => void; delay: number }[] = [];
	const timeouts: { callback: () => void; delay: number }[] = [];
	const handles = new Map<string, (event: unknown) => unknown>();
	const windows: FakeWindow[] = [];
	let userData = "/fixture/custom-user-data";
	let menu: { submenu?: { label?: string; click?: () => void | Promise<void> }[] }[] = [];
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
	class FakeWebContents extends EventEmitter {
		mainFrame = { url: "http://127.0.0.1:9000/" };
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
		restore() { this.minimized = false; }
		focus() { this.focused = true; }
		show() {}
		close() {
			windows.splice(windows.indexOf(this), 1);
			this.emit("closed");
		}
		static fromWebContents(contents: FakeWebContents) { return windows.find(win => win.webContents === contents); }
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
		Menu: { buildFromTemplate: (value: typeof menu) => value, setApplicationMenu: (value: typeof menu) => { menu = value; } },
		ipcMain: { on() {}, handle: (channel: string, fn: (event: unknown) => unknown) => handles.set(channel, fn) },
		nativeTheme: { shouldUseDarkColors: true, themeSource: "system", on() {} },
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
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
		run, updater, windows, intervals, timeouts, handles, settingsReads, order, app, record, installArgs,
		setSettings: (value: unknown) => { settings = JSON.stringify(value); },
		setSettingsFailure: (value: string | Error) => { settings = value; },
		window: () => run("createWindow(process.env.LH_DEV_URL).win") as FakeWindow,
		untrustedWindow: () => new FakeWindow(),
		state: () => JSON.parse(JSON.stringify(run("updateState"))),
		check: async (manual = false) => { run(`checkForUpdates({ manual: ${manual} })`); await Promise.resolve(); await Promise.resolve(); },
		menuCheck: () => menu[0]!.submenu!.find(item => item.label === "Check for Updates…")!.click!(),
	};
}

describe("automatic-update preference gate", () => {
	it("explicit OFF skips automatic checks, but manual checks still run without reading the preference", async () => {
		const f = fixture();
		f.setSettings({ general: { autoUpdate: false } });
		f.run("setupAutoUpdater()");
		await f.check();
		assert.equal(f.updater.checks, 0);
		assert.deepEqual(f.settingsReads, ["/fixture/custom-user-data-dev/data/settings.json"]);
		await f.check(true);
		assert.equal(f.updater.checks, 1);
		assert.equal(f.settingsReads.length, 1);
		assert.equal(f.updater.autoDownload, false, "downloads only on click");
		assert.equal(f.updater.autoInstallOnAppQuit, false, "never installs on quit");
		assert.equal(f.updater.fullChangelog, true, "notes for every skipped version");
	});

	for (const [label, setting] of [
		["ON", { general: { autoUpdate: true } }], ["absent field", { general: {} }],
		["absent section", { version: 1 }], ["null", null], ["non-boolean", { general: { autoUpdate: "false" } }],
	] as const) {
		it(`${label} keeps automatic checks enabled`, async () => {
			const f = fixture(); f.setSettings(setting); f.run("setupAutoUpdater()"); await f.check();
			assert.equal(f.updater.checks, 1);
		});
	}
	for (const [label, failure] of [["missing", new Error("ENOENT")], ["unreadable", new Error("EACCES")], ["corrupt", "{nope"]] as const) {
		it(`${label} settings keep automatic checks enabled`, async () => {
			const f = fixture(); f.setSettingsFailure(failure); f.run("setupAutoUpdater()"); await f.check();
			assert.equal(f.updater.checks, 1);
		});
	}

	it("re-reads the setting on each check, without triggering a check merely when saved", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.setSettings({ general: { autoUpdate: false } }); await f.check();
		f.setSettings({ general: { autoUpdate: true } });
		assert.equal(f.updater.checks, 0);
		await f.check();
		f.setSettings({ general: { autoUpdate: false } }); await f.check();
		assert.equal(f.updater.checks, 1);
		assert.equal(f.settingsReads.length, 3);
	});

	for (const label of ["unpackaged", "missing updater"] as const) {
		it(`${label} stays unavailable, not a saved OFF preference`, async () => {
			const f = fixture({ packaged: label !== "unpackaged", updaterMissing: label === "missing updater" });
			f.run("setupAutoUpdater()"); await f.check(true); await f.check();
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
		const f = fixture(); f.updater.result = null; f.run("setupAutoUpdater()"); await f.check(true);
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

	it("OFF does not cancel in-flight events; Install re-checks, then kills the server before installing", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		f.setSettings({ general: { autoUpdate: false } });
		f.updater.emit("update-downloaded", { version: "0.3.8" }); await f.check();
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
		f.updater.failure = new Error("https://private.example/feed 500"); await f.check(true);
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
		assert.equal(f.run("fixtureRestarts"), 1, "the bundled server stopped for the install starts again");
		f.updater.emit("error", new Error("a later background error"));
		assert.equal(f.state().status, "downloaded", "a later error doesn't hide it");
		// Install again works, and the failure no longer applies.
		f.updater.failure = null;
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

	it("a Download click during a running check waits for it, then downloads (T3's admitAfterCheck)", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		let finish!: () => void;
		const original = f.updater.checkForUpdates.bind(f.updater);
		f.updater.checkForUpdates = function () { this.checks++; this.emit("checking-for-update"); return new Promise((resolve) => { finish = () => resolve({ updateInfo: { version: "0.3.8" } }); }); };
		f.run("checkForUpdates({ manual: true })");
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
		f.updater.failure = new Error("offline"); await f.check(true);
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

	it("Install is a trusted IPC call that answers whether main took it", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
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
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
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

describe("startup, timer, trusted IPC and menu wiring", () => {
	it("starts and retains the 4h timer without any Settings subscription, checking current preference each time", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } });
		await f.run("main()");
		assert.equal(f.updater.checks, 0);
		assert.equal(f.intervals.length, 1); assert.equal(f.intervals[0]!.delay, 4 * 60 * 60 * 1000);
		// Each check settles before the next one (a check of ours still running skips another, as T3's does).
		const settle = () => new Promise((resolve) => setImmediate(resolve));
		f.setSettings({ general: { autoUpdate: true } }); f.intervals[0]!.callback(); await settle();
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
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
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

	it("menu restores/focuses a minimized window, opens General, and manually checks while OFF", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
		const win = f.windows[0]!; win.webContents.loading = false; win.minimized = true;
		f.menuCheck();
		assert.equal(win.minimized, false); assert.equal(win.focused, true);
		assert.ok(win.webContents.messages.some(message => message.channel === "lh:open-settings" && message.value === "general"));
		assert.equal(f.updater.checks, 1);
	});

	it("menu reopens a window and delivers General after load; loading existing windows are covered too", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
		f.windows[0]!.close(); await f.menuCheck();
		assert.equal(f.windows.length, 1); assert.equal(f.updater.checks, 1);
		const win = f.windows[0]!;
		assert.ok(!win.webContents.messages.some(message => message.channel === "lh:open-settings"));
		win.webContents.emit("did-finish-load");
		assert.ok(win.webContents.messages.some(message => message.channel === "lh:open-settings"));
		f.menuCheck(); win.webContents.emit("did-finish-load");
		assert.equal(win.webContents.messages.filter(message => message.channel === "lh:open-settings").length, 2);
	});

	it("menu navigation failure does not prevent its manual check", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
		f.windows[0]!.webContents.fails = true; f.windows[0]!.webContents.loading = false;
		f.menuCheck(); assert.equal(f.updater.checks, 1);
	});
});
