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

type State = { status: string; version: string | null };

function fixture({ state = { status: "available", version: V72 } as State, offered = V72 as string | null, running = false, answers = [] as number[] } = {}) {
	const log: string[] = [];
	const dialogs: Array<{ title?: string; message: string; detail?: string; buttons: string[] }> = [];
	const current = { ...state };
	const flags = { running, checkFails: false, downloadFails: false, inFlight: null as string | null, offered, pinnedFeed: null as string | null };
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
		state: () => current,
		offerAgain: (version: string) => { log.push(`offer ${version}`); Object.assign(current, { status: "available", version }); },
		report: (status: string) => { log.push(`report ${status}`); current.status = status; },
		installing: () => false,
		startInstall: () => log.push(`quit and install ${current.version}`),
		adoptNotes: (info: { version: string }) => log.push(`notes ${info.version}`),
		appVersion: V71,
		compareVersions,
		show: async (options: { title?: string; message: string; detail?: string; buttons: string[] }) => { dialogs.push(options); return { response: answers.shift() ?? 1 }; },
		download: () => log.push("menu download"),
		install: async () => { log.push("menu install"); },
		running: () => flags.running,
		pinFeed: (version: string | null) => { log.push(`pin feed ${version}`); flags.pinnedFeed = version; if (version) flags.offered = version; },
		log: () => {},
		wait: async () => {},
	});
	return { actions, updater, log, dialogs, current, flags, remove: () => { present = null; } };
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

test("an older download already under way finishes first, then the pinned one downloads", async () => {
	const f = fixture({ state: { status: "downloading", version: V72 }, offered: V73 });
	f.flags.inFlight = V72;
	await f.actions.downloadPinned(V73);
	assert.deepEqual(f.log, [`download ${V72}`, `download ${V73}`]);
	assert.deepEqual(f.current, { status: "downloaded", version: V73 });
	assert.equal(f.updater.listenerCount("update-downloaded"), 0);
});

test("a failed pinned download over an older ready one offers the pinned version again, not the deleted download", async () => {
	const f = fixture({ state: { status: "downloaded", version: V72 }, offered: V73 });
	f.flags.downloadFails = true;
	await assert.rejects(f.actions.downloadPinned(V73), /checksum/);
	assert.deepEqual(f.current, { status: "available", version: V73 }, "electron-updater emptied its cache when it started V73");
	assert.equal(f.updater.listenerCount("update-downloaded"), 0, "the listener goes on failure too");
	await assert.rejects(f.actions.downloadPinned(V73));
	assert.equal(f.log.filter((line) => line.startsWith("offer")).length, 1, "a plain failure (nothing older ready) changes nothing");
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

test("the menu's check uses T3's dialogs, and stays out of an Update everything run", async () => {
	const busy = fixture({ running: true });
	await busy.actions.checkNatively();
	assert.deepEqual(busy.dialogs.map((dialog) => dialog.message), ["Update everything is running."]);
	assert.deepEqual(busy.log, [], "no check, download or install during a run");

	const off = fixture();
	off.remove();
	await off.actions.checkNatively();
	assert.deepEqual([off.dialogs[0]!.title, off.dialogs[0]!.message], ["Updates unavailable", "Automatic updates are not available right now."]);

	const current = fixture({ state: { status: "up-to-date", version: null } });
	await current.actions.checkNatively();
	assert.deepEqual([current.dialogs[0]!.title, current.dialogs[0]!.message], ["You're up to date!", `LearnHarness ${V71} is currently the newest version available.`]);

	const offer = fixture({ answers: [0] });
	await offer.actions.checkNatively();
	assert.deepEqual([offer.dialogs[0]!.message, offer.dialogs[0]!.detail, offer.dialogs[0]!.buttons], [`LearnHarness ${V72} is available.`, `You're running LearnHarness ${V71}.`, ["Download", "Later"]]);
	assert.equal(offer.log.at(-1), "menu download");

	const ready = fixture({ state: { status: "downloaded", version: V72 }, answers: [0] });
	await ready.actions.checkNatively();
	assert.deepEqual([ready.dialogs[0]!.message, ready.dialogs[0]!.buttons], [`LearnHarness ${V72} is ready to install.`, ["Restart", "Later"]]);
	assert.equal(ready.log.at(-1), "menu install");

	const raced = fixture({ state: { status: "downloaded", version: V72 }, answers: [0] });
	raced.flags.running = false;
	const showing = raced.actions.checkNatively();
	raced.flags.running = true; // a run started while the dialog was open
	await showing;
	assert.equal(raced.log.includes("menu install"), false);

	const failed = fixture({ state: { status: "idle", version: null } });
	failed.flags.checkFails = true;
	await failed.actions.checkNatively();
	assert.deepEqual([failed.dialogs[0]!.title, failed.dialogs[0]!.message], ["Update check failed", "Could not check for updates."]);
});
