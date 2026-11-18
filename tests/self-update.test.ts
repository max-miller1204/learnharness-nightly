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
import { CHECK_INTERVAL_MS, createSelfUpdater, type SelfUpdaterDeps } from "../src/server/self-update.ts";
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
		const u = createSelfUpdater(f.deps);
		u.start();
		await settle();
		assert.deepEqual(f.sent, [{ type: "prepared", updateId: "u-1" }]);
		f.toParent({ type: "committed", updateId: "u-1" });
		assert.equal(u.state().status, "up-to-date");
		assert.equal(u.state().message, `Updated to version ${CURRENT}.`);
		assert.equal(u.state().notice, null);
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
