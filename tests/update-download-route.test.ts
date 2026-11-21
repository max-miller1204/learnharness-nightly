/**
 * POST /api/updates/download (docs/specs/t3-style-updates.md, revision
 * PR 5): the route downloads the offered version and answers with the state
 * after it; two clicks and a check meanwhile stage it once. The routes run
 * on the process's updater, here one with fake deps. Its sign-in and
 * cross-site rules are proxy.ts's (tests/login-gate.test.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSelfUpdater, type SelfUpdaterDeps, type SelfUpdateState } from "../src/server/self-update.ts";
import type { LatestFeed } from "../selfhost/src/release.ts";

const CURRENT = "0.6.1-nightly.20261120.1";
const NEXT = "0.6.1-nightly.20261121.2";
const feed = (version: string): LatestFeed => ({ version, tag: `v${version}`, sha: "x", publishedAt: "now", launcherProtocol: 1, minLauncherProtocol: 1, assets: {}, notes: [] });

const staged: string[] = [];
let releaseStage: () => void = () => {};
let fetches = 0;
const deps: SelfUpdaterDeps = {
	enabled: true, currentVersion: CURRENT, home: "/tmp/lh", feedUrl: "file:///feed",
	send: () => {}, onParentMessage: () => {},
	fetchLatest: async () => { fetches++; return feed(NEXT); },
	fetchRelease: async (version) => feed(version),
	stage: (f) => new Promise<void>((resolve) => { releaseStage = () => { staged.push(f.version); resolve(); }; }),
	isInstalled: () => false, isStale: () => false, readState: () => undefined, mergeNotes: () => {},
	dismissedNotice: () => undefined, recordDismissedNotice: () => {},
	waitUntilServing: async () => {}, notify: () => {}, now: () => 0,
	setTimeout: () => 0, clearTimeout: () => {},
};
const updater = createSelfUpdater(deps);
// selfUpdater()'s process singleton (src/server/self-update.ts), set before the routes load.
(globalThis as Record<symbol, unknown>)[Symbol.for("learnharness.self-updater")] = updater;

const settle = () => new Promise((resolve) => setImmediate(resolve));
const body = async (response: Promise<Response>) => (await (await response).json()) as SelfUpdateState;

describe("POST /api/updates/download", () => {
	it("downloads the offered version once, whatever else is clicked meanwhile, and answers with the result", async () => {
		const { POST: download } = await import("../app/api/updates/download/route.ts");
		const { POST: check } = await import("../app/api/updates/check/route.ts");
		const offered = await body(check());
		assert.equal(offered.status, "available", "a check offers, it doesn't download");
		assert.deepEqual(staged, []);
		const first = body(download());
		const second = body(download());
		await settle();
		assert.equal(updater.state().status, "downloading");
		const checked = body(check());
		await settle();
		assert.equal(fetches, 1, "the check joins the download");
		releaseStage();
		const answers = await Promise.all([first, second, checked]);
		assert.deepEqual(answers.map((state) => [state.status, state.version]), [["downloaded", NEXT], ["downloaded", NEXT], ["downloaded", NEXT]]);
		assert.deepEqual(staged, [NEXT], "staged once");
		const again = await body(download());
		assert.equal(again.status, "downloaded", "a later click changes nothing");
		assert.deepEqual(staged, [NEXT]);
	});
});
