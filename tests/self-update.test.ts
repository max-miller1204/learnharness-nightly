/**
 * The self-hosted in-app updater (src/server/self-update.ts) with fake
 * deps: disabled outside self-hosting, no toggle, a check offering a newer
 * version that downloads only on a click (docs/specs/t3-style-updates.md,
 * revision PR 5), never applying on its own, a newer version replacing an
 * offered or ready one, install re-checking first, release
 * notes from the feed, the handshake with the launcher, and the rollback
 * notice (dismissible per server). Plus the one-server-per-data-folder lock
 * (src/server/data-lock.ts).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { CHECK_AFTER_COMMIT_MS, CHECK_AFTER_START_MS, CHECK_INTERVAL_MS, createSelfUpdater, healthIdle, publicUpdateState, shouldReportDownloadProgress, type SelfUpdaterDeps } from "../src/server/self-update.ts";
import type { ReleaseNoteGroup } from "../src/core/release-notes.ts";
import { dataLockPath, tryAcquireDataLock } from "../src/server/data-lock.ts";
import type { ChildMessage } from "../selfhost/src/protocol.ts";
import { fetchRelease, parseFeed, readBody, releaseFeedUrl, type LatestFeed, type ServiceState } from "../selfhost/src/release.ts";
import { DATE_CASES, noteTimeShapes, OFFERED, OLDER as OLDER_NOTE } from "./release-date-cases.ts";

const CURRENT = "0.6.1-nightly.20261116.1";
const NEXT = "0.6.1-nightly.20261117.2";
const NEWER = "0.6.1-nightly.20261118.3";
const OLDER = "0.6.1-nightly.20261115.1";
const NEWEST = "0.6.1-nightly.20261119.4";
const NOTES = [NEWER, NEXT, CURRENT, OLDER].map((version) => ({ version, publishedAt: "2026-11-17T00:00:00Z", items: [`**${version}.** changed`] }));
const feed = (version: string): LatestFeed => ({ version, tag: `v${version}`, sha: "x", publishedAt: "now", launcherProtocol: 1, minLauncherProtocol: 1, assets: {}, notes: NOTES });

function fake(overrides: Partial<SelfUpdaterDeps> = {}) {
	const sent: ChildMessage[] = [];
	const timers: Array<{ cb: () => void; ms: number; id: number }> = [];
	let parent: ((m: unknown) => void) | undefined;
	let id = 0;
	let notifications = 0;
	const flags = {
		fetches: 0, installed: false, staged: [] as string[], latest: NEXT, state: undefined as ServiceState | undefined, now: 10_000_000,
		merged: [] as ReleaseNoteGroup[][], dismissed: undefined as string | undefined, fetchFails: false, pinned: [] as string[],
	};
	const deps: SelfUpdaterDeps = {
		enabled: true,
		currentVersion: CURRENT,
		home: "/tmp/lh",
		feedUrl: "file:///feed",
		send: (m) => { sent.push(m); },
		onParentMessage: (cb) => { parent = cb; },
		fetchLatest: async () => { flags.fetches++; if (flags.fetchFails) throw new Error("offline"); return feed(flags.latest); },
		fetchRelease: async (version) => { if (flags.fetchFails) throw new Error("offline"); flags.pinned.push(version); return feed(version); },
		stage: async (f) => { flags.staged.push(f.version); },
		isInstalled: () => flags.installed,
		isStale: () => false,
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
/** The refusal, or how staging ended. */
const pin = async (u: ReturnType<typeof createSelfUpdater>, version: string) => {
	const started = u.startInstallVersion(version);
	return started.refused ?? await started.done;
};

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

	it("checks 15 s after start and every 4 hours, and offers a newer version without downloading or applying it", async () => {
		const f = fake();
		const u = createSelfUpdater(f.deps);
		u.start();
		await settle();
		assert.equal(f.flags.fetches, 0, "not at once (T3: 15 s after launch)");
		assert.equal(CHECK_AFTER_START_MS, 15_000);
		assert.equal(CHECK_INTERVAL_MS, 4 * 60 * 60 * 1000, "every 4 hours");
		assert.deepEqual(f.timers.map((t) => t.ms).sort(), [CHECK_AFTER_START_MS, CHECK_INTERVAL_MS].sort(), "no idle apply loop");
		f.run(CHECK_AFTER_START_MS);
		await settle();
		assert.equal(u.state().status, "available");
		assert.equal(u.state().version, NEXT);
		assert.equal(u.state().availableVersion, NEXT);
		assert.deepEqual(u.state().releaseNotes.map((g) => g.version), [NEXT], "offered with its notes");
		assert.deepEqual(f.flags.staged, [], "nothing downloads in the background");
		assert.equal(u.state().runningVersion, CURRENT, "the page compares its own version with this");
		f.run(CHECK_INTERVAL_MS);
		await settle();
		assert.equal(f.flags.fetches, 2);
		assert.deepEqual(f.flags.staged, []);
		assert.deepEqual(f.sent, [], "no request without a click");
		assert.ok(f.notifications() > 0, "changes are announced");
	});

	it("has no toggle: every automatic check runs, whatever an old settings file says", async () => {
		const f = fake();
		const u = createSelfUpdater(f.deps);
		u.start();
		f.run(CHECK_AFTER_START_MS);
		await settle();
		for (let i = 0; i < 3; i++) { f.run(CHECK_INTERVAL_MS); await settle(); }
		assert.equal(f.flags.fetches, 4);
		assert.equal(u.state().status, "available");
	});

	it("an offered version that is already on disk (staged before a restart) is ready at once", async () => {
		const f = fake();
		f.flags.installed = true;
		const u = createSelfUpdater(f.deps);
		await u.check();
		assert.equal(u.state().status, "downloaded");
		assert.deepEqual(f.flags.staged, []);
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

	it("dates the offered note from the feed's own pointer time when its own is unreadable, and an older note by its build day", async () => {
		for (const c of DATE_CASES) for (const shape of noteTimeShapes(c)) {
			// latest.json as the feed serves it, read the way the launcher reads it.
			const latest = parseFeed({
				version: OFFERED, tag: `v${OFFERED}`, sha: "x", publishedAt: c.pointer, launcherProtocol: 1, minLauncherProtocol: 1, assets: {},
				notes: [OFFERED, OLDER_NOTE].map((version) => ({ version, ...(shape === "missing" ? {} : { publishedAt: c.own }), items: ["changed"] })),
			});
			const f = fake({ currentVersion: "0.6.1-nightly.20261118.1", fetchLatest: async () => latest });
			const u = createSelfUpdater(f.deps);
			await u.check();
			assert.deepEqual(u.state().releaseNotes.map((g) => [g.version, g.releasedAt]), [[OFFERED, c.offered], [OLDER_NOTE, c.older]], `${c.name} (${shape})`);
		}
	});

	it("keeps checking while a version is offered or ready: a newer one replaces it, a failed check keeps it", async () => {
		const f = fake();
		const u = createSelfUpdater(f.deps);
		await u.check();
		f.flags.fetchFails = true;
		const failed = u.check();
		assert.equal(u.state().status, "available", "no checking flicker over an offer");
		await failed;
		assert.equal(u.state().status, "available", "a failed check keeps the offer");
		assert.equal(u.state().message, null);
		f.flags.fetchFails = false;
		await u.download();
		assert.equal(u.state().status, "downloaded");
		assert.equal(u.state().version, NEXT);
		f.flags.latest = NEWER;
		await u.check();
		assert.equal(u.state().status, "available", "a newer version is offered in its place (T3's reduceOnUpdateAvailable)");
		assert.equal(u.state().version, NEWER);
		assert.deepEqual(u.state().releaseNotes.map((g) => g.version), [NEWER, NEXT]);
		assert.deepEqual(f.flags.staged, [NEXT], "and not downloaded");
		await u.download();
		f.flags.fetchFails = true;
		await u.check();
		assert.equal(u.state().status, "downloaded", "a failed check keeps the ready version");
		assert.equal(u.state().version, NEWER);
	});

	it("Download stages the offered version once: a second click and a check meanwhile join it", async () => {
		const f = fake();
		let release: () => void = () => {};
		f.deps.stage = (fd) => new Promise<void>((resolve) => { release = () => { f.flags.staged.push(fd.version); resolve(); }; });
		const u = createSelfUpdater(f.deps);
		await u.download();
		assert.equal(u.state().status, "idle", "nothing offered: nothing to download");
		await u.check();
		const first = u.download();
		const second = u.download();
		await settle();
		assert.equal(u.state().status, "downloading");
		assert.equal(u.busy(), true);
		const checked = u.check();
		await settle();
		assert.equal(f.flags.fetches, 1, "a check during the download joins it");
		release();
		await Promise.all([first, second, checked]);
		assert.deepEqual(f.flags.staged, [NEXT], "staged once");
		assert.equal(u.state().status, "downloaded");
		assert.equal(u.busy(), false);
		assert.deepEqual(f.sent, [], "downloaded, never applied");
	});

	it("Download during a check waits for it, then downloads what it offers", async () => {
		const f = fake();
		let releaseFetch: () => void = () => {};
		f.deps.fetchLatest = async () => { await new Promise<void>((resolve) => { releaseFetch = resolve; }); return feed(f.flags.latest); };
		const u = createSelfUpdater(f.deps);
		const checking = u.check();
		const downloading = u.download();
		await settle();
		assert.equal(u.state().status, "checking");
		releaseFetch();
		await Promise.all([checking, downloading]);
		assert.deepEqual(f.flags.staged, [NEXT]);
		assert.equal(u.state().status, "downloaded");
		// An offer replaced by a newer one while the click waits: the newer one downloads.
		f.flags.latest = NEWER;
		const recheck = u.check();
		const next = u.download();
		await settle();
		releaseFetch();
		await Promise.all([recheck, next]);
		assert.deepEqual(f.flags.staged, [NEXT, NEWER]);
		assert.equal(u.state().version, NEWER);
	});

	it("a failed download keeps the offer with the download context, and Download retries it", async () => {
		const f = fake();
		let fails = true;
		f.deps.stage = async (fd) => { if (fails) throw new Error("SHA-256 mismatch for /home/someone/x.tar.gz"); f.flags.staged.push(fd.version); };
		const u = createSelfUpdater(f.deps);
		await u.check();
		await u.download();
		assert.equal(u.state().status, "available", "still offered (T3's reduceOnDownloadFailure)");
		assert.equal(u.state().errorContext, "download");
		assert.equal(u.state().availableVersion, NEXT);
		assert.match(u.state().message ?? "", /SHA-256/, "signed in: the details");
		assert.equal(publicUpdateState(u.state()).message, null, "not without a session");
		await u.check();
		assert.deepEqual([u.state().status, u.state().errorContext, u.state().message], ["available", null, null], "a re-check offers it afresh (T3's reduceOnUpdateAvailable)");
		fails = false;
		await u.download();
		assert.equal(u.state().status, "downloaded");
		assert.equal(u.state().errorContext, null);
		assert.equal(u.state().message, null);
		assert.deepEqual(f.flags.staged, [NEXT]);
	});

	it("a pulled release stops being offered: a feed rolled back to the running version clears the offer", async () => {
		const f = fake();
		f.flags.latest = NEWER;
		const u = createSelfUpdater(f.deps);
		await u.check();
		assert.equal(u.state().status, "available");
		f.flags.latest = CURRENT;
		await u.check();
		assert.deepEqual([u.state().status, u.state().version, u.state().availableVersion, u.state().releaseNotes.length], ["up-to-date", null, null, 0], "T3's reduceOnNoUpdate with nothing downloaded");
		await u.download();
		assert.deepEqual(f.flags.staged, [], "nothing left to download");
		// A feed rolled back to an older nightly that is still newer than the running one: that one is offered.
		f.flags.latest = NEWER;
		await u.check();
		f.flags.latest = NEXT;
		await u.check();
		assert.equal(u.state().version, NEXT);
		await u.download();
		assert.deepEqual(f.flags.staged, [NEXT], "the version the feed now names");
		// A version marked bad since it was offered is dropped too.
		const g = fake();
		const v = createSelfUpdater(g.deps);
		await v.check();
		g.flags.state = { protocol: 1, activeVersion: CURRENT, badVersions: [NEXT] };
		await v.check();
		assert.equal(v.state().status, "up-to-date");
		// A staged version stays as it was.
		const h = fake();
		const w = createSelfUpdater(h.deps);
		await w.check(); await w.download();
		h.flags.latest = CURRENT;
		await w.check();
		assert.deepEqual([w.state().status, w.state().version], ["downloaded", NEXT]);
	});

	it("a re-check that finds the offered version at a corrected asset downloads the new asset", async () => {
		const f = fake();
		const asset = (sha256: string) => ({ "linux-x64": { url: `https://example.test/${sha256.slice(0, 4)}.tar.gz`, sha256 } });
		let assets = asset("a".repeat(64));
		f.deps.fetchLatest = async () => ({ ...feed(NEXT), assets });
		const seen: string[] = [];
		let fails = true;
		f.deps.stage = async (fd) => { seen.push(fd.assets["linux-x64"]!.sha256); if (fails) throw new Error("HTTP 404"); };
		const u = createSelfUpdater(f.deps);
		await u.check();
		await u.download();
		assert.equal(u.state().errorContext, "download");
		assets = asset("b".repeat(64));
		fails = false;
		await u.check();
		await u.download();
		assert.deepEqual(seen, ["a".repeat(64), "b".repeat(64)], "the repaired asset, not the first one's URL and checksum");
		assert.equal(u.state().status, "downloaded");
	});

	it("Install always reads the feed again, even with a download running: it waits for it, then takes the newer version", async () => {
		const f = fake();
		let release: () => void = () => {};
		f.deps.stage = (fd) => new Promise<void>((resolve) => { release = () => { f.flags.staged.push(fd.version); resolve(); }; });
		const u = createSelfUpdater(f.deps);
		await u.check();
		const downloading = u.download();
		await settle();
		f.flags.latest = NEWER;
		const installing = u.install();
		await settle();
		assert.equal(f.flags.fetches, 1, "it waits for the download");
		release();
		await downloading;
		await settle();
		assert.equal(f.flags.fetches, 2, "then reads the feed itself, never joining the download");
		release();
		await installing;
		assert.deepEqual(f.flags.staged, [NEXT, NEWER]);
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEWER }]);
	});

	it("Install falls back to the staged version when the newer one fails to download", async () => {
		const f = fake();
		f.deps.stage = async (fd) => { if (fd.version === NEWER) throw new Error("HTTP 503"); f.flags.staged.push(fd.version); };
		f.deps.isInstalled = (version) => f.flags.staged.includes(version);
		const u = createSelfUpdater(f.deps);
		await u.check(); await u.download();
		f.flags.latest = NEWER;
		await u.check();
		assert.deepEqual([u.state().status, u.state().version], ["available", NEWER], "the newer one is offered");
		await u.install();
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEXT }], "the staged one installs (as `lh update --now` did)");
		// Nothing staged to fall back to: nothing installs.
		const g = fake();
		g.deps.stage = async () => { throw new Error("HTTP 503"); };
		const v = createSelfUpdater(g.deps);
		await v.install();
		assert.deepEqual(g.sent, []);
		assert.deepEqual([v.state().status, v.state().errorContext], ["available", "download"]);
	});

	/** A fake whose disk holds what it staged, from which archive, and whose stage fails for `failing`. */
	const disk = (failing: string[] = []) => {
		const f = fake();
		const archives = new Map<string, string>();
		const sha = (fd: LatestFeed) => fd.assets["linux-x64"]?.sha256 ?? "none";
		f.deps.stage = async (fd) => { if (failing.includes(fd.version)) throw new Error("HTTP 503"); archives.set(fd.version, sha(fd)); f.flags.staged.push(fd.version); };
		f.deps.isInstalled = (version) => archives.has(version);
		f.deps.isStale = (fd) => archives.has(fd.version) && archives.get(fd.version) !== sha(fd);
		return { f, failing, archives };
	};

	it("the fallback is the newest staged version that is still valid, shown with its own notes", async () => {
		const { f, failing } = disk();
		const u = createSelfUpdater(f.deps);
		for (const version of [NEXT, NEWER]) { f.flags.latest = version; await u.check(); await u.download(); }
		f.flags.latest = NEWEST;
		failing.push(NEWEST);
		await u.install();
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEWER }], "NEWER is staged and valid");
		assert.deepEqual([u.state().version, u.state().availableVersion], [NEWER, NEWER], "the state names what restarts");
		assert.deepEqual(u.state().releaseNotes.map((g) => g.version), [NEWER, NEXT], "with its own notes, not the failed build's");
	});

	it("a staged version the feed went below is withdrawn for good: never a fallback, unless the feed names it again", async () => {
		// The V2, V3, V4, V2, V4 sequence: the feed went below NEWER, so NEXT is the newest valid one.
		const a = disk([NEWEST]);
		const u = createSelfUpdater(a.f.deps);
		for (const version of [NEXT, NEWER]) { a.f.flags.latest = version; await u.check(); await u.download(); }
		a.f.flags.latest = NEWEST;
		await u.check();
		a.f.flags.latest = NEXT;
		await u.check();
		a.f.flags.latest = NEWEST;
		await u.check(); // the feed comes back above it: NEWER stays withdrawn
		await u.install();
		assert.deepEqual(a.f.sent, [{ type: "request-update", targetVersion: NEXT }], "never the withdrawn NEWER");
		assert.deepEqual(u.state().releaseNotes.map((g) => g.version), [NEXT]);
		// V3 ready, the feed drops to V2 (not staged), then V4 fails: nothing valid to fall back to.
		const b = disk([NEXT, NEWEST]);
		const v = createSelfUpdater(b.f.deps);
		b.f.flags.latest = NEWER;
		await v.check(); await v.download();
		b.f.flags.latest = NEXT;
		await v.check();
		b.f.flags.latest = NEWEST;
		await v.install();
		assert.deepEqual(b.f.sent, [], "the withdrawn NEWER is not installed");
		// Named again by the feed, it is a candidate again.
		const c = disk([NEWEST]);
		const w = createSelfUpdater(c.f.deps);
		for (const version of [NEXT, NEWER]) { c.f.flags.latest = version; await w.check(); await w.download(); }
		c.f.flags.latest = NEXT;
		await w.check();
		c.f.flags.latest = NEWER;
		await w.check();
		assert.deepEqual([w.state().status, w.state().version], ["downloaded", NEWER]);
		c.f.flags.latest = NEWEST;
		await w.install();
		assert.deepEqual(c.f.sent, [{ type: "request-update", targetVersion: NEWER }]);
	});

	it("a feed that goes below a staged version offers the version it names, with its own notes; the withdrawn one is never a fallback", async () => {
		const { f, failing } = disk();
		const u = createSelfUpdater(f.deps);
		f.flags.latest = NEWER;
		await u.check(); await u.download();
		assert.deepEqual([u.state().status, u.state().version], ["downloaded", NEWER]);
		f.flags.latest = NEXT;
		await u.check();
		assert.deepEqual([u.state().status, u.state().version, u.state().availableVersion], ["available", NEXT, NEXT], "the feed now names NEXT (T3's reduceOnUpdateAvailable)");
		assert.deepEqual(u.state().releaseNotes.map((g) => g.version), [NEXT], "the version and its notes agree");
		// NEXT's download fails at Install: NEWER was withdrawn, so nothing installs.
		failing.push(NEXT);
		await u.install();
		assert.deepEqual(f.sent, [], "a withdrawn version is never a fallback");
		// NEXT once it is staged: it shows as downloaded, and Install takes it.
		failing.splice(0);
		await u.download();
		assert.deepEqual([u.state().status, u.state().version], ["downloaded", NEXT]);
		f.flags.latest = NEWER;
		await u.check();
		f.flags.latest = NEXT;
		await u.check();
		assert.deepEqual([u.state().status, u.state().version], ["downloaded", NEXT], "a staged NEXT shows as downloaded when the feed names it");
		await u.install();
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEXT }]);
	});

	it("no fallback when Install's own check finds nothing newer (a pulled release) or can't read the feed", async () => {
		const pulled = disk([NEWER]);
		const u = createSelfUpdater(pulled.f.deps);
		await u.check(); await u.download();
		pulled.f.flags.latest = NEWER;
		await u.check();
		pulled.f.flags.latest = CURRENT;
		await u.install();
		assert.deepEqual(pulled.f.sent, [], "the feed withdrew everything newer: nothing installs");
		assert.equal(u.state().status, "up-to-date");

		const offline = disk([NEWER]);
		const v = createSelfUpdater(offline.f.deps);
		await v.check(); await v.download();
		offline.f.flags.latest = NEWER;
		await v.check();
		offline.f.flags.fetchFails = true;
		await v.install();
		assert.deepEqual(offline.f.sent, [], "a check that failed never falls back");
	});

	it("a staged version the feed republishes from another archive is stale: it is offered and staged again", async () => {
		const { f, archives } = disk();
		const asset = (c: string) => ({ "linux-x64": { url: `https://example.test/${c}.tar.gz`, sha256: c.repeat(64) } });
		let assets = asset("a");
		f.deps.fetchLatest = async () => { f.flags.fetches++; return { ...feed(NEXT), assets }; };
		const u = createSelfUpdater(f.deps);
		await u.check(); await u.download();
		assert.equal(u.state().status, "downloaded");
		assets = asset("b");
		await u.check();
		assert.deepEqual([u.state().status, u.state().version], ["available", NEXT], "the copy on disk is from the old archive");
		await u.install();
		assert.equal(archives.get(NEXT), "b".repeat(64), "staged again from the republished archive");
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEXT }]);
	});

	it("a double click on a Download that fails is one attempt", async () => {
		const f = fake();
		let attempts = 0;
		let reject: (error: Error) => void = () => {};
		f.deps.stage = () => { attempts++; return new Promise<void>((_resolve, no) => { reject = no; }); };
		const u = createSelfUpdater(f.deps);
		await u.check();
		const first = u.download();
		const second = u.download();
		await settle();
		reject(new Error("HTTP 503"));
		await Promise.all([first, second]);
		assert.equal(attempts, 1);
		assert.equal(u.state().errorContext, "download");
	});

	/** An offer whose download failed: the state shows Download with the retry. */
	const failedDownload = async (f: ReturnType<typeof fake>) => {
		const u = createSelfUpdater(f.deps);
		u.start();
		const stage = f.deps.stage;
		f.deps.stage = async () => { throw new Error("HTTP 503"); };
		await u.check(); await u.download();
		f.deps.stage = stage;
		assert.equal(u.state().errorContext, "download");
		return u;
	};

	it("no dead Download after a failed pinned install (startInstallVersion's failure): the retry is cleared", async () => {
		const f = fake();
		const u = await failedDownload(f);
		f.flags.fetchFails = true;
		assert.equal(await pin(u, NEWER), "offline");
		assert.deepEqual([u.state().status, u.state().errorContext], ["error", null]);
	});

	it("no dead Download after the launcher refuses the install (update-rejected): the retry is cleared", async () => {
		const f = fake();
		const u = await failedDownload(f);
		assert.equal(await pin(u, NEWER), null);
		f.toParent({ type: "update-rejected", reason: "Not enough disk space" });
		assert.deepEqual([u.state().status, u.state().errorContext], ["error", null]);
	});

	it("no dead Download when the launcher can't be reached (requestUpdate's catch): the retry is cleared", async () => {
		const f = fake({ send: () => { throw new Error("channel closed"); } });
		const u = await failedDownload(f);
		assert.match(await pin(u, NEWER) ?? "", /Couldn't reach the launcher/);
		assert.deepEqual([u.state().status, u.state().errorContext], ["error", null]);
	});

	it("install re-checks first and takes a newer build; a failed re-check installs the ready one", async () => {
		const f = fake();
		const u = createSelfUpdater(f.deps);
		await u.check();
		f.flags.latest = NEWER;
		await u.install();
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEWER }]);

		assert.deepEqual(f.flags.staged, [NEWER], "Install downloads the newer offer itself");

		const g = fake();
		const v = createSelfUpdater(g.deps);
		await v.check();
		await v.download();
		g.flags.fetchFails = true;
		await v.install();
		assert.deepEqual(g.sent, [{ type: "request-update", targetVersion: NEXT }]);

		// `lh update --now` on a server that only offered it: the one click downloads and installs.
		const h = fake();
		const w = createSelfUpdater(h.deps);
		await w.check();
		await w.install();
		assert.deepEqual(h.flags.staged, [NEXT]);
		assert.deepEqual(h.sent, [{ type: "request-update", targetVersion: NEXT }]);
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

	it("a trial child checks 15 s after its commit, not before (the startup check it skipped)", async () => {
		const f = fake({ trialUpdateId: "u-1" });
		const u = createSelfUpdater(f.deps);
		u.start();
		await settle();
		assert.equal(f.flags.fetches, 0, "no check during the trial");
		assert.deepEqual(f.timers.map((t) => t.ms), [CHECK_INTERVAL_MS], "and no start check: the commit's check replaces it");
		f.toParent({ type: "committed", updateId: "u-1" });
		await settle();
		assert.equal(f.flags.fetches, 0, "not at once: the launcher prunes *.tmp version folders right after the commit");
		assert.equal(CHECK_AFTER_COMMIT_MS, 15_000);
		f.run(CHECK_AFTER_COMMIT_MS);
		await settle();
		assert.equal(u.state().status, "available");
		assert.equal(u.state().version, NEXT);
		assert.deepEqual(f.flags.staged, [], "offered, not downloaded");
		assert.deepEqual(f.sent, [{ type: "prepared", updateId: "u-1" }], "never applied");
	});

	it("startInstallVersion stages exactly the pinned version from its own release, never the newest", async () => {
		const f = fake();
		f.flags.latest = NEWER;
		const u = createSelfUpdater(f.deps);
		u.start();
		assert.equal(await pin(u, NEXT), null);
		assert.deepEqual(f.flags.pinned, [NEXT], "read from v<NEXT>/latest.json, not the moving pointer");
		assert.deepEqual(f.flags.staged, [NEXT]);
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEXT }]);
		assert.equal(await pin(u, NEXT), null, "a repeat of the same request is fine");
		assert.match(await pin(u, NEWER) ?? "", /already starting/);
		await u.check();
		assert.deepEqual(f.flags.staged, [NEXT], "no background check after the request");
	});

	it("startInstallVersion refuses older, same-as-bad, malformed and non-launcher requests, and reports staging failures", async () => {
		const f = fake();
		const u = createSelfUpdater(f.deps);
		assert.equal(await pin(u, CURRENT), null, "already on it: nothing to do");
		assert.match(await pin(u, OLDER) ?? "", /already runs .* newer than/);
		assert.match(await pin(u, "latest") ?? "", /not an exact version/);
		f.flags.state = { protocol: 1, activeVersion: CURRENT, badVersions: [NEXT] };
		assert.match(await pin(u, NEXT) ?? "", /failed to start on this server earlier/);
		f.flags.state = undefined;
		f.flags.fetchFails = true;
		assert.equal(await pin(u, NEXT), "offline");
		assert.equal(u.state().status, "error");
		assert.deepEqual(f.sent, []);
		const off = createSelfUpdater(fake({ enabled: false }).deps);
		assert.match(await pin(off, NEXT) ?? "", /isn't run by the lh launcher/);
	});

	it("startInstallVersion waits for a check in flight and holds the slot while staging", async () => {
		const f = fake();
		let release: () => void = () => {};
		let releaseFetch: () => void = () => {};
		f.deps.stage = (fd) => new Promise<void>((resolve) => { release = () => { f.flags.staged.push(fd.version); resolve(); }; });
		f.deps.fetchLatest = async () => { await new Promise<void>((resolve) => { releaseFetch = resolve; }); return feed(NEXT); };
		const u = createSelfUpdater(f.deps);
		const checking = u.check();
		const pinned = pin(u, NEXT);
		await settle();
		assert.equal(u.busy(), true);
		assert.deepEqual(f.flags.pinned, [], "the pinned install waits for the check");
		releaseFetch();
		await checking;
		await settle();
		assert.equal(u.busy(), true, "the pinned install holds the slot after the check ends");
		release();
		assert.equal(await pinned, null);
		await settle();
		assert.equal(u.busy(), false);
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEXT }]);
	});

	it("answers at once and follows the staging in `pinned`", async () => {
		const f = fake();
		let release: () => void = () => {};
		f.deps.stage = () => new Promise<void>((resolve) => { release = resolve; });
		const u = createSelfUpdater(f.deps);
		u.start();
		const started = u.startInstallVersion(NEXT);
		assert.equal(started.refused, null, "the route can answer before the download");
		const id = u.state().pinned!.id;
		assert.deepEqual(u.state().pinned, { version: NEXT, error: null, id });
		assert.equal(u.startInstallVersion(NEXT).refused, null, "the same request again is harmless");
		assert.equal(u.state().pinned!.id, id, "and joins the same attempt");
		assert.match(u.startInstallVersion(NEWER).refused ?? "", /already starting/);
		await settle();
		release();
		assert.equal(await started.done, null);
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEXT }]);
		f.toParent({ type: "update-rejected", reason: "Not enough disk space" });
		assert.deepEqual(u.state().pinned, { version: NEXT, error: "Not enough disk space", id }, "the launcher's refusal reaches the desktop");
		assert.equal(publicUpdateState(u.state()).pinned?.error, "The update failed.", "no details without a session");

		const g = fake();
		g.flags.fetchFails = true;
		const v = createSelfUpdater(g.deps);
		assert.equal(await pin(v, NEXT), "offline");
		const failedId = v.state().pinned!.id;
		assert.deepEqual(v.state().pinned, { version: NEXT, error: "offline", id: failedId });
		g.flags.fetchFails = false;
		assert.equal(await pin(v, NEXT), null, "after a failure the same request retries");
		assert.equal(v.state().pinned!.error, null);
		assert.notEqual(v.state().pinned!.id, failedId, "as a new attempt, so the old error can't be read as its result");
	});

	it("a stale pinned error is never this attempt's: joining a switch already under way starts a fresh attempt, and a plain Install's refusal stays out of it", async () => {
		const f = fake();
		f.flags.fetchFails = true;
		const u = createSelfUpdater(f.deps);
		u.start();
		assert.equal(await pin(u, NEXT), "offline");
		const stale = u.state().pinned!.id;
		// The server's own Install then switches to NEXT; a desktop run joins it.
		f.flags.fetchFails = false;
		await u.install();
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEXT }]);
		assert.equal(u.startInstallVersion(NEXT).refused, null);
		assert.equal(u.state().pinned!.error, null);
		assert.notEqual(u.state().pinned!.id, stale);

		const g = fake();
		g.flags.fetchFails = true;
		const v = createSelfUpdater(g.deps);
		v.start();
		assert.equal(await pin(v, NEXT), "offline");
		const left = v.state().pinned;
		g.flags.fetchFails = false;
		await v.install();
		g.toParent({ type: "update-rejected", reason: "Not enough disk space" });
		assert.deepEqual(v.state().pinned, left, "a plain Install's refusal isn't written into an old attempt");
	});

	it("an attempt queued behind the server's own Install for the same version joins it: the launcher's refusal is the attempt's", async () => {
		const f = fake();
		let release: () => void = () => {};
		f.deps.fetchLatest = async () => { await new Promise<void>((resolve) => { release = resolve; }); return feed(NEXT); };
		const u = createSelfUpdater(f.deps);
		u.start();
		// Install's re-check is in flight; Update everything asks for the same version meanwhile.
		const installing = u.install();
		await settle();
		const started = u.startInstallVersion(NEXT);
		assert.equal(started.refused, null);
		const id = u.state().pinned!.id;
		release();
		await installing;
		assert.equal(await started.done, null, "the plain Install asked the launcher first; the attempt joined");
		assert.deepEqual(f.sent, [{ type: "request-update", targetVersion: NEXT }], "one request");
		f.toParent({ type: "update-rejected", reason: "Not enough disk space" });
		assert.deepEqual(u.state().pinned, { version: NEXT, error: "Not enough disk space", id }, "the desktop sees the refusal");
		assert.equal(u.startInstallVersion(NEXT).refused, null);
		assert.notEqual(u.state().pinned!.id, id, "a later run starts a fresh attempt instead of joining a dead one");
	});

	it("an attempt whose launcher can't be reached fails without leaving the launcher's next answer to it", async () => {
		const f = fake({ send: () => { throw new Error("channel closed"); } });
		const u = createSelfUpdater(f.deps);
		assert.match(await pin(u, NEXT) ?? "", /Couldn't reach the launcher/);
		const left = u.state().pinned;
		f.toParent({ type: "update-rejected", reason: "a later plain Install's refusal" });
		assert.deepEqual(u.state().pinned, left);
	});

	it("the download's percent moves the progress ring at each whole 10% (T3's rule); unknown size stays null", async () => {
		assert.equal(shouldReportDownloadProgress(null, 0), true, "the first known percent");
		assert.equal(shouldReportDownloadProgress(0, 9.9), false);
		assert.equal(shouldReportDownloadProgress(9.9, 10), true);
		assert.equal(shouldReportDownloadProgress(99, 100), true);
		assert.equal(shouldReportDownloadProgress(null, null), false, "no size, nothing to report");
		const seen: Array<number | null> = [];
		let feedBytes: ((received: number, total: number | null) => void) | undefined;
		let finish = () => {};
		const f = fake({ stage: (_feed, _bad, onBytes) => { feedBytes = onBytes; return new Promise<void>((resolve) => { finish = resolve; }); } });
		const u = createSelfUpdater(f.deps);
		await u.check();
		const pending = u.download();
		await settle();
		assert.equal(u.state().status, "downloading");
		assert.equal(u.state().downloadPercent, null, "the size isn't known before the response");
		const before = f.notifications();
		for (const received of [0, 5, 40, 99, 100, 101, 250, 999, 1000]) {
			feedBytes!(received, 1000);
			seen.push(u.state().downloadPercent);
		}
		assert.deepEqual(seen, [0, 0, 0, 0, 10, 10, 25, 99.9, 100]);
		assert.equal(f.notifications() - before, 5, "an update event per step, not per chunk");
		assert.equal(publicUpdateState(u.state()).downloadPercent, 100, "public: it is no secret");
		finish();
		await pending;
		assert.equal(u.state().status, "downloaded");
		assert.equal(u.state().downloadPercent, null, "only while downloading");

		const g = fake({ stage: async (_feed, _bad, onBytes) => { onBytes?.(0, null); onBytes?.(5000, null); } });
		const v = createSelfUpdater(g.deps);
		const states: Array<number | null> = [];
		g.deps.notify = () => { states.push(v.state().downloadPercent); };
		await v.check();
		await v.download();
		assert.deepEqual(states.filter((value) => value !== null), [], "unknown size: never a percent");
	});

	it("once every byte is in, the checksum and unpack show a full ring as preparing, until it is ready", async () => {
		let hooks: { onBytes?: (received: number, total: number | null) => void; onPhase?: (phase: "downloading" | "verifying" | "extracting") => void } = {};
		let finish = () => {};
		const f = fake({ stage: (_feed, _bad, onBytes, onPhase) => { hooks = { onBytes, onPhase }; return new Promise<void>((resolve) => { finish = resolve; }); } });
		const u = createSelfUpdater(f.deps);
		await u.check();
		const pending = u.download();
		await settle();
		hooks.onPhase!("downloading");
		hooks.onBytes!(0, null);
		hooks.onBytes!(4000, null);
		assert.equal(u.state().preparing, false);
		assert.equal(u.state().downloadPercent, null, "no size yet: an empty ring");
		hooks.onPhase!("verifying");
		assert.equal(u.state().status, "downloading", "Install still waits for the unpack");
		assert.equal(u.state().preparing, true);
		assert.equal(u.state().downloadPercent, 100, "the ring is full");
		const events = f.notifications();
		hooks.onPhase!("extracting");
		hooks.onBytes!(4000, 4000);
		assert.equal(f.notifications(), events, "the unpack and late byte counts send nothing new");
		finish();
		await pending;
		assert.equal(u.state().status, "downloaded");
		assert.equal(u.state().preparing, false);
	});

	it("a pinned download (Update everything) moves the ring too", async () => {
		let feedBytes: ((received: number, total: number | null) => void) | undefined;
		let finish = () => {};
		const f = fake({ stage: (_feed, _bad, onBytes) => { feedBytes = onBytes; return new Promise<void>((resolve) => { finish = resolve; }); } });
		const u = createSelfUpdater(f.deps);
		const started = u.startInstallVersion(NEXT);
		await settle();
		feedBytes!(512, 2048);
		assert.equal(u.state().downloadPercent, 25);
		finish();
		await started.done;
	});

	it("counts a response's bytes as they arrive against Content-Length", async () => {
		const chunks = [new Uint8Array(3), new Uint8Array(5), new Uint8Array(2)];
		const body = () => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
		const calls: Array<[number, number | null]> = [];
		const bytes = await readBody(new Response(body(), { headers: { "content-length": "10" } }), (received, total) => calls.push([received, total]));
		assert.equal(bytes.length, 10);
		assert.deepEqual(calls, [[0, 10], [3, 10], [8, 10], [10, 10]]);
		const unknown: Array<number | null> = [];
		await readBody(new Response(body()), (_received, total) => unknown.push(total));
		assert.ok(unknown.every((total) => total === null), "no Content-Length: unknown size");
		const encoded: Array<number | null> = [];
		await readBody(new Response(body(), { headers: { "content-length": "4", "content-encoding": "gzip" } }), (_received, total) => encoded.push(total));
		assert.ok(encoded.every((total) => total === null), "a compressed transfer's length isn't the bytes read");
	});

	it("is committed unless it is a trial the launcher hasn't committed yet", async () => {
		assert.equal(createSelfUpdater(fake().deps).state().committed, true);
		const f = fake({ trialUpdateId: "u-1" });
		const u = createSelfUpdater(f.deps);
		u.start();
		await settle();
		assert.equal(u.state().committed, false, "a trial answers health before it is kept");
		f.toParent({ type: "committed", updateId: "u-1" });
		assert.equal(u.state().committed, true);
	});

	it("adopts a rollback recorded by the launcher at boot", () => {
		const f = fake();
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

describe("one exact release's feed (Update everything)", () => {
	it("sits beside the nightly pointer, under the version's own tag", () => {
		assert.equal(releaseFeedUrl(NEXT), `https://github.com/max-miller1204/learnharness-nightly/releases/download/v${NEXT}/latest.json`);
		assert.equal(releaseFeedUrl(NEXT, "file:///tmp/x/nightly/latest.json"), `file:///tmp/x/v${NEXT}/latest.json`);
		assert.throws(() => releaseFeedUrl(NEXT, "https://mirror.example/feed.json"), /next to the feed/);
		assert.throws(() => releaseFeedUrl("../../evil"), /not an exact version/);
	});

	it("must name the version it was asked for", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-release-"));
		try {
			const write = (version: string, body: LatestFeed) => {
				fs.mkdirSync(path.join(root, `v${version}`), { recursive: true });
				fs.writeFileSync(path.join(root, `v${version}`, "latest.json"), JSON.stringify(body));
			};
			write(NEXT, { ...feed(NEXT), sha: "abc" });
			write(NEWER, feed(NEXT));
			const pointer = `file://${root}/nightly/latest.json`;
			assert.equal((await fetchRelease(NEXT, pointer)).sha, "abc");
			await assert.rejects(fetchRelease(NEWER, pointer), /names/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("GET /api/health's update fields", () => {
	it("callers that aren't signed in learn that an update failed, but not the error text", async () => {
		const f = fake();
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

	it("is not idle while an update check or download runs", async () => {
		let releaseStage: () => void = () => {};
		const f = fake({
			stage: async (feed) => {
				if (feed.version === NEWER) await new Promise<void>((resolve) => { releaseStage = resolve; });
				f.flags.staged.push(feed.version);
			},
		});
		const u = createSelfUpdater(f.deps);
		await u.check();
		assert.equal(healthIdle(true, u.busy()), true, "offered and nothing running: idle");
		await u.download();
		assert.equal(u.state().status, "downloaded");
		assert.equal(u.busy(), false);
		assert.equal(healthIdle(true, u.busy()), true, "ready and nothing running: idle");

		f.flags.latest = NEWER;
		await u.check();
		const downloading = u.download();
		await settle();
		assert.equal(u.state().status, "downloading");
		assert.equal(u.busy(), true, "the newer one is downloading");
		assert.equal(healthIdle(true, u.busy()), false, "so health is not idle");

		releaseStage();
		await downloading;
		assert.equal(u.state().version, NEWER);
		assert.equal(u.busy(), false);
		assert.equal(healthIdle(true, u.busy()), true);

		// A manual check while ready, and the plain checking/downloading case, count too.
		let releaseFetch: () => void = () => {};
		const g = fake({ fetchLatest: async () => { await new Promise<void>((resolve) => { releaseFetch = resolve; }); return feed(NEXT); } });
		const v = createSelfUpdater(g.deps);
		const pending = v.check();
		assert.equal(v.state().status, "checking");
		assert.equal(healthIdle(true, v.busy()), false, "fetching the feed");
		releaseFetch();
		await pending;
		assert.equal(healthIdle(true, v.busy()), true);
		assert.equal(healthIdle(false, false), false, "running work still counts");
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
