/**
 * The self-hosted in-app updater (src/server/self-update.ts) with fake
 * deps: disabled outside self-hosting, autoUpdate=false skips automatic
 * checks, idle gating (each busy source blocks the switch), the handshake
 * with the launcher, and the boot notices from service-state.json. Plus the
 * one-server-per-data-folder lock (src/server/data-lock.ts).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { CHECK_INTERVAL_MS, createSelfUpdater, IDLE_POLL_MS, UPDATED_NOTICE_MS, type SelfUpdaterDeps } from "../src/server/self-update.ts";
import { dataLockPath, tryAcquireDataLock } from "../src/server/data-lock.ts";
import type { ChildMessage } from "../selfhost/src/protocol.ts";
import type { LatestFeed, ServiceState } from "../selfhost/src/release.ts";

const CURRENT = "0.6.1-nightly.20261116.1";
const NEXT = "0.6.1-nightly.20261117.2";
const feed = (version: string): LatestFeed => ({ version, tag: `v${version}`, sha: "x", publishedAt: "now", launcherProtocol: 1, minLauncherProtocol: 1, assets: {} });

function fake(overrides: Partial<SelfUpdaterDeps> = {}) {
	const sent: ChildMessage[] = [];
	const timers: Array<{ cb: () => void; ms: number; id: number }> = [];
	let parent: ((m: unknown) => void) | undefined;
	let id = 0;
	let notifications = 0;
	const flags = { idle: true, auto: true, installed: false, staged: [] as string[], latest: NEXT, state: undefined as ServiceState | undefined, now: 10_000_000 };
	const deps: SelfUpdaterDeps = {
		enabled: true,
		currentVersion: CURRENT,
		home: "/tmp/lh",
		feedUrl: "file:///feed",
		send: (m) => { sent.push(m); },
		onParentMessage: (cb) => { parent = cb; },
		isIdle: () => flags.idle,
		autoUpdateEnabled: () => flags.auto,
		fetchLatest: async () => feed(flags.latest),
		stage: async (f) => { flags.staged.push(f.version); },
		isInstalled: () => flags.installed,
		readState: () => flags.state,
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

	it("checks at startup, downloads, then applies once idle", async () => {
		const f = fake();
		const u = createSelfUpdater(f.deps);
		f.flags.idle = false;
		u.start();
		await settle();
		assert.equal(u.state().status, "downloaded");
		assert.equal(u.state().version, NEXT);
		assert.deepEqual(f.flags.staged, [NEXT]);
		f.run(0);
		assert.deepEqual(f.sent, [], "busy: no request yet");
		f.flags.idle = true;
		f.run(IDLE_POLL_MS);
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEXT }]);
		assert.ok(f.notifications() > 0, "changes are announced");
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

	it("install applies right away even when busy, and shows a rejection", async () => {
		const f = fake();
		f.flags.idle = false;
		const u = createSelfUpdater(f.deps);
		u.start();
		await u.install();
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEXT }]);
		f.toParent({ type: "update-rejected", reason: "Not enough disk space" });
		assert.equal(u.state().status, "error");
		assert.equal(u.state().message, "Not enough disk space");
	});

	it("as a trial child, says prepared once serving; committed shows the updated notice", async () => {
		const f = fake({ trialUpdateId: "u-1" });
		const u = createSelfUpdater(f.deps);
		u.start();
		await settle();
		assert.deepEqual(f.sent, [{ type: "prepared", updateId: "u-1" }]);
		f.toParent({ type: "committed", updateId: "u-1" });
		assert.equal(u.state().notice?.kind, "updated");
		f.flags.now += UPDATED_NOTICE_MS + 1;
		assert.equal(u.state().notice, null, "the updated notice expires");
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
