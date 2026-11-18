/**
 * The self-hosted in-app updater (src/server/self-update.ts) with fake
 * deps: disabled outside self-hosting, autoUpdate=false skips automatic
 * checks, never applying on its own (docs/specs/t3-style-updates.md), a
 * newer version replacing a ready one, install re-checking first, release
 * notes from the feed, the handshake with the launcher, and the rollback
 * notice (dismissible per server). Plus the one-server-per-data-folder lock
 * (src/server/data-lock.ts).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { CHECK_AFTER_COMMIT_MS, CHECK_INTERVAL_MS, createSelfUpdater, healthIdle, publicUpdateState, type SelfUpdaterDeps } from "../src/server/self-update.ts";
import type { ReleaseNoteGroup } from "../src/core/release-notes.ts";
import { dataLockPath, tryAcquireDataLock } from "../src/server/data-lock.ts";
import type { ChildMessage } from "../selfhost/src/protocol.ts";
import type { LatestFeed, ServiceState } from "../selfhost/src/release.ts";

const CURRENT = "0.6.1-nightly.20261116.1";
const NEXT = "0.6.1-nightly.20261117.2";
const NEWER = "0.6.1-nightly.20261118.3";
const OLDER = "0.6.1-nightly.20261115.1";
const NOTES = [NEWER, NEXT, CURRENT, OLDER].map((version) => ({ version, publishedAt: "2026-11-17T00:00:00Z", items: [`**${version}.** changed`] }));
const feed = (version: string): LatestFeed => ({ version, tag: `v${version}`, sha: "x", publishedAt: "now", launcherProtocol: 1, minLauncherProtocol: 1, assets: {}, notes: NOTES });

function fake(overrides: Partial<SelfUpdaterDeps> = {}) {
	const sent: ChildMessage[] = [];
	const timers: Array<{ cb: () => void; ms: number; id: number }> = [];
	let parent: ((m: unknown) => void) | undefined;
	let id = 0;
	let notifications = 0;
	const flags = {
		auto: true, installed: false, staged: [] as string[], latest: NEXT, state: undefined as ServiceState | undefined, now: 10_000_000,
		merged: [] as ReleaseNoteGroup[][], dismissed: undefined as string | undefined, fetchFails: false,
	};
	const deps: SelfUpdaterDeps = {
		enabled: true,
		currentVersion: CURRENT,
		home: "/tmp/lh",
		feedUrl: "file:///feed",
		send: (m) => { sent.push(m); },
		onParentMessage: (cb) => { parent = cb; },
		autoUpdateEnabled: () => flags.auto,
		fetchLatest: async () => { if (flags.fetchFails) throw new Error("offline"); return feed(flags.latest); },
		stage: async (f) => { flags.staged.push(f.version); },
		isInstalled: () => flags.installed,
		readState: () => flags.state,
		mergeNotes: (groups) => { flags.merged.push(groups); },
		dismissedNotice: () => flags.dismissed,
		recordDismissedNotice: (id) => { flags.dismissed = id; },
		waitUntilServing: async () => {},
		notify: () => { notifications++; },
		now: () => flags.now,
		setTimeout: (cb, ms) => { const t = { cb, ms, id: ++id }; timers.push(t); return t.id; },
		clearTimeout: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
		...overrides,
	};
	const run = (ms: number) => {
		const i = timers.findIndex((t) => t.ms === ms);
		assert.ok(i >= 0, `a ${ms}ms timer is pending`);
		const [t] = timers.splice(i, 1);
		t!.cb();
	};
	return { deps, sent, timers, run, flags, toParent: (m: unknown) => parent?.(m), notifications: () => notifications };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("self-hosted updater", () => {
	it("is disabled and inert outside self-hosting", async () => {
		const f = fake({ enabled: false });
		const u = createSelfUpdater(f.deps);
		u.start();
		await u.check();
		await u.install();
		assert.equal(u.state().status, "disabled");
		assert.equal(f.timers.length, 0);
		assert.deepEqual(f.sent, []);
	});

	it("checks at startup and downloads, but never applies on its own", async () => {
		const f = fake();
		const u = createSelfUpdater(f.deps);
		u.start();
		await settle();
		assert.equal(u.state().status, "downloaded");
		assert.equal(u.state().version, NEXT);
		assert.deepEqual(f.flags.staged, [NEXT]);
		assert.equal(CHECK_INTERVAL_MS, 4 * 60 * 60 * 1000, "every 4 hours");
		assert.equal(u.state().runningVersion, CURRENT, "the page compares its own version with this");
		assert.deepEqual(f.timers.map((t) => t.ms), [CHECK_INTERVAL_MS], "only the check timer: no idle apply loop");
		f.run(CHECK_INTERVAL_MS);
		await settle();
		assert.deepEqual(f.sent, [], "no request without a click");
		assert.ok(f.notifications() > 0, "changes are announced");
	});

	it("carries the feed's notes for versions after the running one, and caches them", async () => {
		const f = fake();
		f.flags.latest = NEWER;
		const u = createSelfUpdater(f.deps);
		await u.check();
		assert.deepEqual(u.state().releaseNotes.map((g) => g.version), [NEWER, NEXT], "newest first, only newer than the running version");
		assert.equal(u.state().omittedReleaseCount, 0);
		assert.deepEqual(f.flags.merged[0]!.map((g) => g.version), [NEWER, NEXT, CURRENT, OLDER], "the whole history goes to the cache");
	});

	it("keeps checking while a version is ready: a newer one replaces it after staging", async () => {
		const f = fake();
		const u = createSelfUpdater(f.deps);
		await u.check();
		assert.equal(u.state().version, NEXT);
		f.flags.latest = NEWER;
		let release!: () => void;
		f.deps.stage = (fd) => new Promise<void>((resolve) => { release = () => { f.flags.staged.push(fd.version); resolve(); }; });
		const pending = u.check();
		await settle();
		assert.equal(u.state().status, "downloaded");
		assert.equal(u.state().version, NEXT, "the ready version stays offered while the newer one stages");
		release();
		await pending;
		assert.equal(u.state().version, NEWER);
		assert.deepEqual(u.state().releaseNotes.map((g) => g.version), [NEWER, NEXT]);
		f.flags.fetchFails = true;
		await u.check();
		assert.equal(u.state().status, "downloaded", "a failed check keeps the ready version");
	});

	it("install re-checks first and takes a newer build; a failed re-check installs the ready one", async () => {
		const f = fake();
		const u = createSelfUpdater(f.deps);
		await u.check();
		f.flags.latest = NEWER;
		await u.install();
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEWER }]);

		const g = fake();
		const v = createSelfUpdater(g.deps);
		await v.check();
		g.flags.fetchFails = true;
		await v.install();
		assert.deepEqual(g.sent, [{ type: "request-update", targetVersion: NEXT }]);
	});

	it("skips automatic checks when autoUpdate is off, but manual checks work", async () => {
		const f = fake();
		f.flags.auto = false;
		const u = createSelfUpdater(f.deps);
		u.start();
		await settle();
		assert.equal(u.state().status, "idle");
		f.run(CHECK_INTERVAL_MS);
		await settle();
		assert.equal(u.state().status, "idle", "the periodic check is skipped too");
		await u.check();
		assert.equal(u.state().status, "downloaded");
	});

	it("reports up-to-date and skips versions marked bad", async () => {
		const f = fake();
		f.flags.latest = CURRENT;
		const u = createSelfUpdater(f.deps);
		await u.check();
		assert.equal(u.state().status, "up-to-date");
		f.flags.latest = NEXT;
		f.flags.state = { protocol: 1, activeVersion: CURRENT, badVersions: [NEXT] };
		await u.check();
		assert.equal(u.state().status, "up-to-date");
		assert.match(u.state().message ?? "", /failed to start earlier/);
		assert.deepEqual(f.flags.staged, []);
	});

	it("install applies on click, and shows a rejection", async () => {
		const f = fake();
		const u = createSelfUpdater(f.deps);
		u.start();
		await u.install();
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEXT }]);
		f.toParent({ type: "update-rejected", reason: "Not enough disk space" });
		assert.equal(u.state().status, "error");
		assert.equal(u.state().message, "Not enough disk space");
	});

	it("as a trial child, says prepared once serving; committed says so without a notice (What's new replaces it)", async () => {
		const f = fake({ trialUpdateId: "u-1" });
		f.flags.auto = false; // the check that follows a commit is the next test
		const u = createSelfUpdater(f.deps);
		u.start();
		await settle();
		assert.deepEqual(f.sent, [{ type: "prepared", updateId: "u-1" }]);
		f.toParent({ type: "committed", updateId: "u-1" });
		assert.equal(u.state().status, "up-to-date");
		assert.equal(u.state().message, `Updated to version ${CURRENT}.`);
		assert.equal(u.state().notice, null);
	});

	it("a trial child checks 15 s after its commit, not before (the startup check it skipped)", async () => {
		const f = fake({ trialUpdateId: "u-1" });
		const u = createSelfUpdater(f.deps);
		u.start();
		await settle();
		assert.deepEqual(f.flags.staged, [], "no check during the trial");
		f.toParent({ type: "committed", updateId: "u-1" });
		await settle();
		assert.deepEqual(f.flags.staged, [], "not at once: the launcher prunes *.tmp version folders right after the commit");
		assert.equal(CHECK_AFTER_COMMIT_MS, 15_000);
		f.run(CHECK_AFTER_COMMIT_MS);
		await settle();
		assert.equal(u.state().status, "downloaded");
		assert.equal(u.state().version, NEXT);
		assert.deepEqual(f.flags.staged, [NEXT]);
		assert.deepEqual(f.sent, [{ type: "prepared", updateId: "u-1" }], "downloaded, never applied");

		const off = fake({ trialUpdateId: "u-2" });
		off.flags.auto = false;
		createSelfUpdater(off.deps).start();
		await settle();
		off.toParent({ type: "committed", updateId: "u-2" });
		off.run(CHECK_AFTER_COMMIT_MS);
		await settle();
		assert.deepEqual(off.flags.staged, [], "the toggle still gates it");
	});

	it("adopts a rollback recorded by the launcher at boot", () => {
		const f = fake();
		f.flags.auto = false;
		f.flags.state = { protocol: 1, activeVersion: CURRENT, badVersions: [NEXT], update: { id: "u", fromVersion: CURRENT, targetVersion: NEXT, status: "rolled-back", reason: "candidate-exited:1", at: 5 } };
		const u = createSelfUpdater(f.deps);
		u.start();
		assert.equal(u.state().status, "error");
		assert.equal(u.state().notice?.kind, "rolled-back");
		assert.match(u.state().notice?.text ?? "", /rolled back/);
		u.dismissNotice();
		assert.equal(u.state().notice, null);
		assert.equal(u.state().message, null, "dismissing also clears the Settings text");
		assert.equal(u.state().status, "idle");
		assert.equal(f.flags.dismissed, `rolled-back:${NEXT}:5`, "recorded per server");
		const again = createSelfUpdater(f.deps);
		again.start();
		assert.equal(again.state().notice, null, "a dismissed notice is not adopted again at boot");
		assert.equal(again.state().message, null, "nor its text (Settings shows it only while undismissed)");
		assert.notEqual(again.state().instance, u.state().instance, "each server process has its own instance id");
	});
});

describe("GET /api/health's update fields", () => {
	it("callers that aren't signed in learn that an update failed, but not the error text", async () => {
		const f = fake();
		f.flags.auto = false;
		f.flags.state = { protocol: 1, activeVersion: CURRENT, badVersions: [NEXT], update: { id: "u", fromVersion: CURRENT, targetVersion: NEXT, status: "rolled-back", reason: "ENOSPC: /home/someone/.learnharness", at: 5 } };
		const u = createSelfUpdater(f.deps);
		u.start();
		const full = u.state();
		assert.match(full.message ?? "", /ENOSPC/, "signed in: the details");
		const open = publicUpdateState(full);
		assert.equal(open.status, "error", "still says it failed");
		assert.equal(open.message, null);
		assert.equal(open.notice?.kind, "rolled-back");
		assert.equal(open.notice?.text, `Update to version ${NEXT} failed to start and was rolled back.`);
		assert.doesNotMatch(JSON.stringify(open), /ENOSPC|someone/);
		assert.equal(open.runningVersion, CURRENT, "runningVersion stays public");

		// A rejected install request: error text from the launcher.
		const g = fake();
		const v = createSelfUpdater(g.deps);
		v.start();
		await settle();
		await v.install();
		g.toParent({ type: "update-rejected", reason: "Not enough disk space under /home/someone" });
		assert.match(v.state().message ?? "", /disk space/);
		assert.equal(publicUpdateState(v.state()).message, null);
		assert.equal(publicUpdateState(v.state()).status, "error");
		// Non-error messages are not error details.
		assert.equal(publicUpdateState({ ...v.state(), status: "downloaded", message: "Restarting to install version x…" }).message, "Restarting to install version x…");
	});

	it("is not idle while an update is checked for or downloaded (the launcher's relaunch waits for idle)", () => {
		assert.equal(healthIdle(true, { status: "downloading" }), false);
		assert.equal(healthIdle(true, { status: "checking" }), false);
		assert.equal(healthIdle(true, { status: "downloaded" }), true);
		assert.equal(healthIdle(true, { status: "up-to-date" }), true);
		assert.equal(healthIdle(false, { status: "idle" }), false);
	});
});

describe("data-folder lock", () => {
	it("a second server on the same data folder can't take the lock", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-data-lock-"));
		try {
			const first = await tryAcquireDataLock(dataLockPath(dir));
			assert.ok(first);
			assert.equal(await tryAcquireDataLock(dataLockPath(dir)), undefined);
			first.close();
			const again = await tryAcquireDataLock(dataLockPath(dir));
			assert.ok(again, "free again once the holder closes");
			again.close();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
