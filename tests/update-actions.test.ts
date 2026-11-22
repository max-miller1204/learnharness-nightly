/**
 * main.cjs's updater actions (electron/update-actions.cjs) against a fake
 * electron-updater: the pinned version, its download (an older download in
 * flight, a failed download over an older ready one, no listener left
 * behind), the pinned install, and the app menu's native dialogs, which
 * stay out of the way of an Update everything run.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createUpdateActions } = require("../electron/update-actions.cjs");
const { compareVersions } = require("../electron/release-notes.cjs");

const V71 = "0.6.1-nightly.20261118.71";
const V72 = "0.6.1-nightly.20261118.72";
const V73 = "0.6.1-nightly.20261118.73";

type State = { status: string; version: string | null; revision?: number; availableVersion?: string | null; downloadedVersion?: string | null; message?: string | null };

function fixture({ state = { status: "available", version: V72 } as State, offered = V72 as string | null, running = false, restartsApp = true, answers = [] as number[] } = {}) {
	const log: string[] = [];
	const started: string[] = [];
	const dialogs: Array<{ title?: string; message: string; detail?: string; buttons: string[] }> = [];
	const parents: unknown[] = [];
	const appWindow = { name: "app window" };
	const current = { ...state };
	const flags = {
		running, installing: false, checkFails: false, downloadFails: false, inFlight: null as string | null, offered, pinnedFeed: null as string | null, activateFails: false,
		/** Whether the menu's own check ran ({ checked }), and what happens while a dialog is open. */
		checked: true, whileOpen: null as (() => void) | null, appWindowShown: true,
		/** What main's Download or Restart does when pressed: by default it takes it. */
		onAction: null as (() => unknown) | null,
	};
	const updater = Object.assign(new EventEmitter(), {
		checkForUpdates: async () => {
			log.push("check");
			if (flags.checkFails) throw new Error("feed down");
			return flags.offered ? { updateInfo: { version: flags.offered } } : null;
		},
		downloadUpdate: async () => {
			// electron-updater returns a download already under way, for its own version.
			const version = flags.inFlight ?? flags.offered;
			flags.inFlight = null;
			log.push(`download ${version}`);
			if (flags.downloadFails) throw new Error("sha512 checksum mismatch");
			Object.assign(current, { status: "downloaded", version });
			updater.emit("update-downloaded", { version });
		},
	});
	let present: typeof updater | null = updater;
	const actions = createUpdateActions({
		updater: () => present,
		// A copy, as main replaces its state on every change (setUpdateState).
		state: () => ({ ...current }),
		downloadFailed: (version: string) => { log.push(`offer ${version}`); Object.assign(current, { status: "available", version }); },
		// Main's own check: a failure shows main's fixed line in the state.
		check: async () => {
			log.push("main check");
			if (flags.checkFails) Object.assign(current, { status: "error", message: "Couldn’t check for updates. Try again later." });
			return { checked: flags.checked };
		},
		activate: () => { log.push("activate"); if (flags.activateFails) throw new Error("no window"); return appWindow; },
		appWindow: () => (flags.appWindowShown ? appWindow : null),
		downloadStarted: (version: string) => { started.push(version); },
		installing: () => flags.installing,
		startInstall: () => log.push(`quit and install ${current.version}`),
		adoptNotes: (info: { version: string }) => log.push(`notes ${info.version}`),
		appVersion: V71,
		compareVersions,
		show: async (options: { title?: string; message: string; detail?: string; buttons: string[] }, parent?: unknown) => {
			dialogs.push(options);
			parents.push(parent ?? null);
			flags.whileOpen?.();
			return { response: answers.shift() ?? 1 };
		},
		download: async (version: string) => { log.push(`menu download ${version}`); return flags.onAction?.(); },
		install: async (version: string) => { log.push(`menu install ${version}`); return flags.onAction?.(); },
		running: () => flags.running,
		restartsApp: () => restartsApp,
		pinFeed: (version: string | null) => { log.push(`pin feed ${version}`); flags.pinnedFeed = version; if (version) flags.offered = version; },
		log: () => {},
		wait: async () => {},
	});
	return { actions, updater, log, started, dialogs, parents, appWindow, current, flags, remove: () => { present = null; } };
}

test("pin re-checks the feed and keeps only a version newer than this app", async () => {
	const f = fixture();
	assert.equal(await f.actions.pin(), V72);
	assert.deepEqual(f.log, ["check", `notes ${V72}`]);
	f.flags.offered = V71;
	assert.equal(await f.actions.pin(), null, "not newer");
	f.remove();
	assert.equal(await f.actions.pin(), null, "updates off");
});

test("downloadPinned downloads exactly the pinned version and leaves no listener behind", async () => {
	const f = fixture();
	await f.actions.downloadPinned(V72);
	assert.deepEqual(f.log, [`download ${V72}`]);
	assert.equal(f.updater.listenerCount("update-downloaded"), 0);
	await f.actions.downloadPinned(V72);
	assert.deepEqual(f.log, [`download ${V72}`], "already downloaded: nothing to fetch");
});

test("Update everything's download and Try Again's start the ring at 0, before the first progress event", async () => {
	const f = fixture();
	f.updater.downloadUpdate = async () => {
		assert.deepEqual(f.started, [V72], "reported before the download begins");
		Object.assign(f.current, { status: "downloaded", version: V72 });
		f.updater.emit("update-downloaded", { version: V72 });
	};
	await f.actions.downloadPinned(V72);
	const retry = fixture();
	await retry.actions.downloadExact(V72);
	assert.deepEqual(retry.started, [V72], "the app-only retry too");
});

test("an older download already under way finishes first, then the pinned one downloads", async () => {
	const f = fixture({ state: { status: "downloading", version: V72 }, offered: V73 });
	f.flags.inFlight = V72;
	await f.actions.downloadPinned(V73);
	assert.deepEqual(f.log, [`download ${V72}`, `download ${V73}`]);
	assert.deepEqual(f.current, { status: "downloaded", version: V73 });
	assert.equal(f.updater.listenerCount("update-downloaded"), 0);
});

test("a failed pinned download offers the pinned version again, over an older ready one too, so nothing stays at 0%", async () => {
	const f = fixture({ state: { status: "downloaded", version: V72 }, offered: V73 });
	f.flags.downloadFails = true;
	await assert.rejects(f.actions.downloadPinned(V73), /checksum/);
	assert.deepEqual(f.started, [V73], "the download names the pinned version from its start");
	assert.deepEqual(f.current, { status: "available", version: V73 }, "electron-updater emptied its cache when it started V73");
	assert.equal(f.updater.listenerCount("update-downloaded"), 0, "the listener goes on failure too");
	await assert.rejects(f.actions.downloadPinned(V73));
	assert.equal(f.log.filter((line) => line.startsWith("offer")).length, 2, "every failure offers it again, to retry");
});

test("downloadExact pins the feed to the version for the retry, then unpins it", async () => {
	const f = fixture({ state: { status: "idle", version: null }, offered: V73 });
	await f.actions.downloadExact(V72);
	assert.deepEqual(f.log, [`pin feed ${V72}`, "check", `notes ${V72}`, `download ${V72}`, "pin feed null"], "V72, though the feed's newest is V73");
	assert.deepEqual(f.current, { status: "downloaded", version: V72 });

	const wrong = fixture({ offered: V73 });
	const actions = wrong.actions;
	wrong.flags.offered = V73;
	const original = wrong.updater.checkForUpdates;
	// A feed that keeps offering another version (it doesn't have V72): refuse, after one more check.
	wrong.updater.checkForUpdates = async () => ({ updateInfo: { version: V73 } });
	await assert.rejects(actions.downloadExact(V72), /offered .*20261118\.73, not .*20261118\.72/);
	assert.equal(wrong.flags.pinnedFeed, null, "unpinned on failure too");
	assert.equal(wrong.log.some((line) => line.startsWith("download")), false);
	wrong.updater.checkForUpdates = original;
});

test("a Try Again during the startup check (which read the newest version before the pin) checks once more, pinned", async () => {
	const f = fixture({ state: { status: "idle", version: null }, offered: V73 });
	let calls = 0;
	const real = f.updater.checkForUpdates;
	f.updater.checkForUpdates = async () => {
		calls++;
		// The first call returns the in-flight unpinned check: the newest, V73.
		if (calls === 1) { f.log.push("check (in flight)"); return { updateInfo: { version: V73 } }; }
		return real();
	};
	await f.actions.downloadExact(V72);
	assert.deepEqual(f.log, [`pin feed ${V72}`, "check (in flight)", "check", `notes ${V72}`, `download ${V72}`, "pin feed null"]);
	assert.deepEqual(f.current, { status: "downloaded", version: V72 });
});

test("installPinned installs only the ready pinned version", () => {
	const f = fixture({ state: { status: "downloaded", version: V72 } });
	assert.throws(() => f.actions.installPinned(V73), /isn't ready/);
	f.actions.installPinned(V72);
	assert.deepEqual(f.log, [`quit and install ${V72}`]);
});

const titles = (f: ReturnType<typeof fixture>) => f.dialogs.map((dialog) => dialog.title);

test("the menu: Updates unavailable (T3 :155-166), before any window opens or check runs", async () => {
	const f = fixture();
	f.remove();
	await f.actions.checkNatively();
	assert.deepEqual([f.dialogs[0]!.title, f.dialogs[0]!.message, f.dialogs[0]!.detail, f.dialogs[0]!.buttons], ["Updates unavailable", "Automatic updates are not available right now.", "Automatic updates are not available in this build.", ["OK"]]);
	assert.deepEqual(f.log, []);
});

test("the menu activates the window, then runs main's check (the sidebar's), then shows the dialog", async () => {
	const f = fixture({ state: { status: "up-to-date", version: null } });
	await f.actions.checkNatively();
	assert.deepEqual(f.log, ["activate", "main check"]);
	assert.deepEqual([f.dialogs[0]!.title, f.dialogs[0]!.message, f.dialogs[0]!.buttons], ["You're up to date!", `LearnHarness ${V71} is currently the newest version available.`, ["OK"]]);
	const failing = fixture({ state: { status: "up-to-date", version: null } });
	failing.flags.activateFails = true;
	await failing.actions.checkNatively();
	assert.deepEqual(failing.log, ["activate", "main check"], "a window that can't open never stops the check");
	assert.deepEqual(titles(failing), ["You're up to date!"]);
});

test("the menu: Update available, Download downloads through main's Download, Later does nothing", async () => {
	const f = fixture({ state: { status: "available", version: V72, availableVersion: V72 }, answers: [0] });
	await f.actions.checkNatively();
	assert.deepEqual([f.dialogs[0]!.title, f.dialogs[0]!.message, f.dialogs[0]!.detail, f.dialogs[0]!.buttons], ["Update available", `LearnHarness ${V72} is available.`, `You're running LearnHarness ${V71}.`, ["Download", "Later"]]);
	assert.equal(f.log.at(-1), `menu download ${V72}`);
	const later = fixture({ state: { status: "available", version: V72, availableVersion: V72 }, answers: [1] });
	await later.actions.checkNatively();
	assert.equal(later.log.some((line) => line.startsWith("menu download")), false);
	const unnamed = fixture({ state: { status: "available", version: null, availableVersion: null } });
	await unnamed.actions.checkNatively();
	assert.equal(unnamed.dialogs[0]!.message, "A new version of LearnHarness is available.");
});

test("the menu mid-download: Update downloading, OK only, nothing started", async () => {
	const f = fixture({ state: { status: "downloading", version: V72, availableVersion: V72 } });
	await f.actions.checkNatively();
	assert.deepEqual([f.dialogs[0]!.title, f.dialogs[0]!.message, f.dialogs[0]!.buttons], ["Update downloading", `LearnHarness ${V72} is already downloading.`, ["OK"]]);
	assert.deepEqual(f.log, ["activate", "main check"]);
});

test("the menu: Update ready, Restart installs through main's Install, Later does nothing", async () => {
	const f = fixture({ state: { status: "downloaded", version: V72, availableVersion: V72, downloadedVersion: V72 }, answers: [0] });
	await f.actions.checkNatively();
	assert.deepEqual([f.dialogs[0]!.title, f.dialogs[0]!.message, f.dialogs[0]!.detail, f.dialogs[0]!.buttons], ["Update ready", `LearnHarness ${V72} is ready to install.`, "LearnHarness will restart to install it. Any running tasks will be interrupted.", ["Restart", "Later"]]);
	assert.equal(f.log.at(-1), `menu install ${V72}`);
	const later = fixture({ state: { status: "downloaded", version: V72, downloadedVersion: V72 }, answers: [1] });
	await later.actions.checkNatively();
	assert.equal(later.log.some((line) => line.startsWith("menu install")), false);
});

test("the menu: Update check failed shows the state's fixed line, else T3's generic one", async () => {
	const f = fixture({ state: { status: "idle", version: null } });
	f.flags.checkFails = true;
	await f.actions.checkNatively();
	assert.deepEqual([f.dialogs[0]!.title, f.dialogs[0]!.message, f.dialogs[0]!.detail], ["Update check failed", "Could not check for updates.", "Couldn’t check for updates. Try again later."]);
	const bare = fixture({ state: { status: "error", version: null, message: null } });
	await bare.actions.checkNatively();
	assert.equal(bare.dialogs[0]!.detail, "An unknown error occurred. Please try again later.");
});

test("a click whose own check didn't run shows no stale dialog: only Update downloading during a download", async () => {
	for (const status of ["available", "downloaded", "up-to-date", "error", "checking"]) {
		const f = fixture({ state: { status, version: V72, availableVersion: V72, downloadedVersion: status === "downloaded" ? V72 : null, message: "x" } });
		f.flags.checked = false; // another check of ours is running
		await f.actions.checkNatively();
		assert.deepEqual(f.dialogs, [], status);
	}
	const downloading = fixture({ state: { status: "downloading", version: V72, availableVersion: V72 } });
	downloading.flags.checked = false;
	await downloading.actions.checkNatively();
	assert.deepEqual(titles(downloading), ["Update downloading"], "T3's state during a download");
	const idle = fixture({ state: { status: "idle", version: null } });
	await idle.actions.checkNatively();
	assert.deepEqual(idle.dialogs, [], "idle shows nothing, as in T3");
});

test("each dialog shows over the window activate() returned", async () => {
	const f = fixture({ state: { status: "up-to-date", version: null } });
	await f.actions.checkNatively();
	assert.deepEqual(f.parents, [f.appWindow]);
});

test("the menu during an Update everything run: Update in progress, and no check", async () => {
	const busy = fixture({ running: true });
	await busy.actions.checkNatively();
	assert.deepEqual([busy.dialogs[0]!.title, busy.dialogs[0]!.message], ["Update in progress", "Update everything is running."]);
	assert.deepEqual(busy.log, [], "no window, check, download or install during a run");
});

test("the menu during a run that only moves the server: this app stays open", async () => {
	const busy = fixture({ running: true, restartsApp: false });
	await busy.actions.checkNatively();
	assert.deepEqual([busy.dialogs[0]!.title, busy.dialogs[0]!.detail], ["Update in progress", "Only the server is updating. LearnHarness stays open."]);
	const restarts = fixture({ running: true });
	await restarts.actions.checkNatively();
	assert.equal(restarts.dialogs[0]!.detail, "LearnHarness restarts by itself when the server is back.");
});

for (const [status, action] of [["downloaded", "menu install"], ["available", "menu download"]] as const) {
	const shown = () => ({ status, version: V72, revision: 3, availableVersion: V72, downloadedVersion: status === "downloaded" ? V72 : null });
	test(`${action}: a run that starts while its dialog is open stops it`, async () => {
		const f = fixture({ state: shown(), answers: [0] });
		f.flags.whileOpen = () => { f.flags.running = true; };
		await f.actions.checkNatively();
		assert.equal(f.log.some((line) => line.startsWith(action)), false);
	});
	test(`${action}: a run that starts and ends while its dialog is open (it staged a newer build) stops it`, async () => {
		const f = fixture({ state: shown(), answers: [0] });
		f.flags.whileOpen = () => { Object.assign(f.current, { status: "downloaded", version: V73, availableVersion: V73, downloadedVersion: V73, revision: 9 }); };
		await f.actions.checkNatively();
		assert.equal(f.log.some((line) => line.startsWith(action)), false, "never the newer build its dialog didn't name");
	});
	test(`${action}: a newer offer found while its dialog is open stops it`, async () => {
		const f = fixture({ state: shown(), answers: [0] });
		f.flags.whileOpen = () => { Object.assign(f.current, { status: "available", version: V73, availableVersion: V73, downloadedVersion: null, revision: 4 }); };
		await f.actions.checkNatively();
		assert.equal(f.log.some((line) => line.startsWith(action)), false);
	});
	test(`${action}: with nothing changed it acts, naming its dialog's version`, async () => {
		const f = fixture({ state: shown(), answers: [0] });
		await f.actions.checkNatively();
		assert.equal(f.log.at(-1), `${action} ${V72}`);
	});
}

for (const [status, action] of [["downloaded", "menu install"], ["available", "menu download"]] as const) {
	const shown = () => ({ status, version: V72, revision: 3, availableVersion: V72, downloadedVersion: status === "downloaded" ? V72 : null });
	test(`${action}: a background check that only bumps the revision while its dialog is open doesn't stop it`, async () => {
		const f = fixture({ state: shown(), answers: [0] });
		f.flags.whileOpen = () => { f.current.revision = 7; };
		await f.actions.checkNatively();
		assert.equal(f.log.at(-1), `${action} ${V72}`);
	});
	test(`${action}: refused by main for another version, the dialog for the new state follows, once`, async () => {
		const f = fixture({ state: shown(), answers: [0, 0] });
		f.flags.onAction = () => {
			Object.assign(f.current, { status: "available", version: V73, availableVersion: V73, downloadedVersion: null });
			return { superseded: true };
		};
		await f.actions.checkNatively();
		assert.deepEqual(f.dialogs.map((dialog) => dialog.message).slice(1), [`LearnHarness ${V73} is available.`], "the user sees why");
		assert.deepEqual(f.log.filter((line) => line.startsWith("menu ")), [`${action} ${V72}`, `menu download ${V73}`], "its Download acts on what it names");
		assert.equal(f.dialogs.length, 2, "a second refusal shows nothing more");
		assert.deepEqual(f.parents, [f.appWindow, f.appWindow]);
	});
	test(`${action}: a refusal that isn't for another version (a failed download) shows no follow-up`, async () => {
		const f = fixture({ state: shown(), answers: [0] });
		f.flags.onAction = () => ({ accepted: true, completed: false });
		await f.actions.checkNatively();
		assert.equal(f.dialogs.length, 1);
	});
}

test("Update in progress and Updates unavailable sit on the shown app window without activating it, else no parent", async () => {
	const busy = fixture({ running: true });
	await busy.actions.checkNatively();
	assert.deepEqual([busy.dialogs[0]!.title, busy.parents[0] === busy.appWindow, busy.log], ["Update in progress", true, []]);
	const off = fixture();
	off.remove();
	await off.actions.checkNatively();
	assert.deepEqual([off.dialogs[0]!.title, off.parents[0] === off.appWindow, off.log], ["Updates unavailable", true, []]);
	const hidden = fixture({ running: true });
	hidden.flags.appWindowShown = false;
	await hidden.actions.checkNatively();
	assert.equal(hidden.parents[0], null);
});

test("the menu while an install is under way shows nothing and checks nothing", async () => {
	const f = fixture({ state: { status: "downloaded", version: V72 } });
	f.flags.installing = true;
	await f.actions.checkNatively();
	assert.deepEqual([f.dialogs, f.log], [[], []]);
});
