/**
 * Update everything (roadmap item 23 PR 2, docs/specs/desktop-server-list.md):
 * electron/update-everything.cjs with a fake updater, server and dialogs, plus
 * the remote bridge's sender check (electron/update-everything-ipc.cjs) and
 * the remote preload's surface. No Electron, network or real updates.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createUpdateEverything, serverLabel, HANDOFF_TIMEOUT_MS, RESTART_DELAY_MS, SAVED_RESULT_MAX_AGE_MS, PAGE_READY_TIMEOUT_MS, ASK_COOLDOWN_MS } = require("../electron/update-everything.cjs");
const { registerDesktopUpdateIPC } = require("../electron/update-everything-ipc.cjs");

const ORIGIN = "https://max-desktop.tail1234.ts.net:8443";
const V71 = "0.6.1-nightly.20261118.71";
const V72 = "0.6.1-nightly.20261118.72";
const V73 = "0.6.1-nightly.20261118.73";

type Reply = { status?: number; body?: unknown } | Error;
type Prompt = { message: string; detail: string; buttons: string[]; signal?: AbortSignal };

function fixture({ server = V71, offered = V72 as string | null, answers = [0, 0] as Array<number | "wait">, saved = null as unknown, downloadFails = false, appNotes = [] as unknown[], duringDownload = () => {},
	countdown = null as AbortController | null, expectReconnect = V72 as string | null, appVersion = V71,
	// Main's own dialog (askInApp): each answer in turn, true for Update; "wait" leaves it open until answer().
	inApp = [true] as Array<boolean | "wait" | { update: boolean; keyboard: boolean }>,
	// The page: "ready" says it shows the capsule at once, "manual" waits for the test, "none" never does (a page from before PR 7).
	page: pageMode = "ready" as "ready" | "manual" | "none",
	// The app's feed can't be read (pin() throws), and its updater is off (a dev or unpackaged build).
	feedDown = false, updaterDisabled = false,
	// Runs while main's dialog is open.
	duringAsk = () => {} } = {}) {
	const reconnects: string[] = [];
	const asked: Array<{ plan: unknown; win: unknown }> = [];
	let answerDialog: (update: boolean) => void = () => {};
	const log: string[] = [];
	const prompts: Prompt[] = [];
	const notices: Array<{ message: string; detail: string }> = [];
	const failures: string[] = [];
	const kinds: string[] = [];
	const progress: string[] = [];
	const requests: Array<{ path: string; method?: string; token?: string; body?: unknown }> = [];
	const results: unknown[] = [];
	let clock = 1_000_000;
	let stored = saved;
	// The server's answers, step by step: /api/updates, then the restart.
	const remote = {
		running: server, committed: true, instance: "old", status: "up-to-date", notice: null as unknown, message: null as string | null,
		health: server as string | null, installReply: null as Reply | null, onInstall: () => {}, items: [{ kind: "turn" }, { kind: "job" }],
		down: false, proxy502: false, installFails: 0, attempts: 0, tick: undefined as (() => void) | undefined,
		pinned: null as unknown, selected: ORIGIN, win: { id: 1 } as object, unpaired: false,
		// The server's page in that window: its loads (deps.page). A reconnect reloads it by
		// default, and `holdLoad` keeps the new page from committing until loadPage().
		reloads: true, holdLoad: false,
		// POSTs that get no answer: the transport gives up after its 15 s timeout (requestServer's),
		// and `startsAnyway` says whether the server got it before the answer was lost.
		postTimeouts: 0, startsAnyway: true,
	};
	const page = { generation: 0, settled: 0, closed: false, watchers: new Set<() => void>(), clocks: 0 };
	const notify = () => { for (const watcher of [...page.watchers]) watcher(); };
	const loadPage = () => {
		page.generation += 1;
		setImmediate(() => { page.settled += 1; notify(); });
	};
	let pendingLoad = false;
	let finished: () => void = () => {};
	const done = new Promise<void>((resolve) => { finished = resolve; });
	const ue = createUpdateEverything({
		appVersion,
		updater: {
			state: () => ({ status: updaterDisabled ? "disabled" : offered ? "available" : "up-to-date", version: offered, releaseNotes: appNotes }),
			check: () => log.push("check"),
			download: () => log.push("download"),
			pin: async () => { log.push("pin"); if (feedDown) throw new Error("ENOTFOUND"); return offered; },
			downloadPinned: async (v: string) => { duringDownload(); if (downloadFails) throw new Error("sha512 checksum mismatch"); log.push(`download ${v}`); },
			// The app-only retry: exactly v, whatever the feed's newest is.
			downloadExact: async (v: string) => { duringDownload(); log.push(`exact ${v}`); },
			installPinned: (v: string) => {
				if (remote.installFails > 0) { remote.installFails--; log.push(`install ${v} failed`); throw new Error("Could not locate update bundle"); }
				log.push(`install ${v}`); finished();
			},
		},
		selection: () => (page.closed ? null : { origin: remote.selected, token: "bearer", win: remote.win }),
		page: (win: unknown) => (win === remote.win ? {
			generation: () => page.generation, settled: () => page.settled, closed: () => page.closed,
			watch: (watcher: () => void) => { page.watchers.add(watcher); return () => { page.watchers.delete(watcher); }; },
		} : null),
		askInApp: async (selection: { win: unknown }, plan: unknown) => {
			asked.push({ plan, win: selection.win });
			duringAsk();
			const answer = inApp.shift() ?? false;
			if (answer === "wait") return new Promise<boolean>((resolve) => { answerDialog = resolve; });
			return answer;
		},
		request: async (origin: string, pathname: string, options: { token?: string; method?: string; body?: unknown }) => {
			assert.equal(origin, ORIGIN, "only the selected server");
			requests.push({ path: pathname, ...options });
			if (pathname === "/api/updates/install-version") {
				if (remote.postTimeouts > 0) {
					remote.postTimeouts--;
					if (remote.startsAnyway) { remote.onInstall(); remote.onInstall = () => {}; }
					clock += 15_000;
					throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
				}
				if (!remote.installReply) {
					// As the server does: a fresh attempt id unless one for this version is going on.
					const pinned = remote.pinned as { version: string; error: string | null } | null;
					if (!pinned || pinned.error || pinned.version !== V72) remote.pinned = { version: V72, error: null, id: `attempt-${++remote.attempts}` };
				}
				const reply = remote.installReply ?? { status: 202, body: { instance: remote.instance, runningVersion: remote.running, pinned: remote.pinned } };
				if (reply instanceof Error) throw reply;
				remote.onInstall();
				remote.onInstall = () => {}; // asking again is harmless, as on the server
				return Response.json(reply.body, { status: reply.status ?? 202 });
			}
			if (remote.down) throw new Error("ECONNREFUSED");
			if (remote.unpaired && pathname === "/api/updates") return Response.json({ error: "unpaired" }, { status: 401 });
			// Tailscale Serve (or any HTTPS proxy) answers 502 while the server is down.
			if (remote.proxy502) return new Response("Bad Gateway", { status: 502 });
			if (pathname === "/api/health") return Response.json({ ok: true, version: remote.health });
			if (pathname === "/api/updates/running") return Response.json({ items: remote.items });
			return Response.json({ runningVersion: remote.running, committed: remote.committed, instance: remote.instance, status: remote.status, notice: remote.notice, message: remote.message, pinned: remote.pinned });
		},
		confirm: async (prompt: Prompt) => {
			prompts.push(prompt);
			const answer = answers.shift() ?? 1;
			if (answer === "wait") return await new Promise<number>((resolve) => prompt.signal!.addEventListener("abort", () => resolve(1)));
			return answer;
		},
		tell: async (notice: { message: string; detail: string }) => { notices.push(notice); finished(); },
		progress: (origin: string, text: string) => { assert.equal(origin, ORIGIN, "the run covers only its own server"); progress.push(text); },
		fail: (origin: string, problem: { kind: string; message: string }) => { failures.push(problem.message); kinds.push(problem.kind); finished(); },
		// As main's endUpdate: async (it claims the version in the page first), then the reload
		// commits and loads a moment after it resolves.
		reconnect: async (origin: string, version: string) => {
			if (expectReconnect !== null) assert.equal(version, expectReconnect, "Later shows the version the server is now on");
			reconnects.push(version);
			log.push(`reconnect ${origin}`);
			finished();
			await new Promise((resolve) => setImmediate(resolve));
			if (!remote.reloads) return false;
			if (remote.holdLoad) pendingLoad = true;
			else setImmediate(loadPage);
			return true;
		},
		saveResult: (record: unknown) => { results.push(record); stored = record; },
		takeResult: () => { const value = stored; stored = null; return value; },
		now: () => clock,
		timeoutSignal: (ms: number) => {
			if (ms === PAGE_READY_TIMEOUT_MS) {
				page.clocks += 1;
				if (pageMode === "none") return AbortSignal.timeout(5);
				if (pageMode === "ready") setImmediate(ready);
				return new AbortController().signal;
			}
			assert.equal(ms, RESTART_DELAY_MS);
			return countdown ? countdown.signal : AbortSignal.timeout(5);
		},
		sleep: async (ms: number) => { clock += ms; remote.tick?.(); await new Promise((resolve) => setImmediate(resolve)); },
	});
	/** The page in the window says it shows the capsule (window.lh.desktopUpdate.ready()). */
	function ready() { ue.ready({ win: remote.win, generation: page.generation }); }
	return {
		ue, log, prompts, notices, failures, kinds, progress, requests, results, remote, done, reconnects, asked, page, ready,
		answer: (update: boolean) => answerDialog(update), advance: (ms: number) => { clock += ms; }, now: () => clock,
		/** The held reload commits and loads. */
		loadPage: () => { if (pendingLoad) { pendingLoad = false; loadPage(); } },
		closeWindow: () => { page.closed = true; notify(); },
	};
}

test("server labels follow the ghost dashboard: first name, or the whole address for an IP", () => {
	assert.equal(serverLabel(ORIGIN), "max-desktop");
	assert.equal(serverLabel("https://100.64.0.7:8443"), "100.64.0.7");
	assert.equal(HANDOFF_TIMEOUT_MS, 32 * 60 * 1000, "T3's 32 minutes");
	assert.equal(RESTART_DELAY_MS, 5_000, "T3's 5 s countdown");
});

test("the happy path: pin, confirm, download, server to exactly X, wait for the commit, then restart", async () => {
	const f = fixture();
	let polls = 0;
	f.remote.onInstall = () => {
		f.remote.proxy502 = true;
		f.remote.tick = () => {
			polls++;
			if (polls === 1) { f.remote.proxy502 = false; f.remote.down = true; }
			if (polls === 2) { f.remote.down = false; f.remote.running = V72; f.remote.health = V72; f.remote.instance = "trial"; f.remote.committed = false; }
			if (polls === 4) f.remote.committed = true;
		};
	};
	await f.ue.install();
	assert.equal(f.prompts[0]!.message, "Update everything?");
	assert.equal(f.prompts[0]!.detail, `Update max-desktop and this app to ${V72}.\n\n1. max-desktop updates first and restarts. This takes a few minutes. 2 running tasks there will stop.\n2. Once max-desktop is back, this app restarts to finish.`);
	assert.deepEqual(f.prompts[0]!.buttons, ["Update everything", "Cancel"]);
	await f.done;
	assert.deepEqual(f.log, ["pin", `download ${V72}`, `install ${V72}`], "downloaded before the server was asked, installed only the pinned version");
	const install = f.requests.find((request) => request.path === "/api/updates/install-version")!;
	assert.deepEqual(install, { path: "/api/updates/install-version", token: "bearer", method: "POST", body: { version: V72 } }, "the server answers at once and stages in the background, so the transport's own timeout is enough");
	assert.deepEqual(f.failures, [], "the proxy's 502 and a refused connection both mean: not back yet");
	const askedAt = f.requests.indexOf(install);
	assert.ok(f.requests.slice(askedAt).some((request) => request.path === "/api/health"), "health is checked");
	assert.ok(polls >= 4, "a healthy trial is not enough: it waits for the launcher's commit");
	assert.deepEqual(f.progress, [`Updating max-desktop to ${V72}… This can take a few minutes.`]);
	assert.equal(f.prompts[1]!.message, `max-desktop is on ${V72}.`);
	assert.equal(f.prompts[1]!.detail, "LearnHarness restarts in 5 seconds to finish updating.");
	assert.deepEqual(f.prompts[1]!.buttons, ["Restart now", "Later"]);
	assert.ok(f.prompts[1]!.signal, "the countdown closes the dialog by itself");
	assert.deepEqual(f.results, [{ savedAt: (f.results[0] as { savedAt: number }).savedAt, server: ORIGIN, updated: ORIGIN, from: V71, target: V72 }], "saved before installing");
});

test("Cancel changes nothing, and install() returns once the dialog is answered", async () => {
	const f = fixture({ answers: [1] });
	await f.ue.install();
	assert.deepEqual(f.log, ["pin"]);
	assert.equal(f.requests.some((request) => request.method === "POST"), false);
	assert.equal(f.ue.running(), false);
});

test("a server already on X skips the server: just an app restart", async () => {
	const f = fixture({ server: V72 });
	await f.ue.install();
	await f.done;
	assert.equal(f.prompts[0]!.message, `Restart LearnHarness to update to ${V72}?`);
	assert.equal(f.prompts[0]!.detail, `max-desktop already runs ${V72}. Only this app restarts.`);
	assert.deepEqual(f.prompts[0]!.buttons, ["Restart", "Cancel"]);
	assert.equal(f.requests.some((request) => request.path === "/api/updates/install-version"), false);
	assert.deepEqual(f.log, ["pin", `download ${V72}`, `install ${V72}`]);
});

test("a server newer than the update stops before asking", async () => {
	const f = fixture({ server: V73 });
	await f.ue.install();
	await f.done;
	assert.equal(f.prompts.length, 0);
	assert.match(f.notices[0]!.detail, new RegExp(`max-desktop runs ${V73.replaceAll(".", "\\.")}, newer than this app’s update`));
});

test("Later keeps the app as it is, reopens the updated server, and a second run only restarts the app", async () => {
	const f = fixture({ answers: [0, 1] });
	f.remote.onInstall = () => { f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; };
	await f.ue.install();
	await f.done;
	assert.deepEqual(f.log, ["pin", `download ${V72}`, `reconnect ${ORIGIN}`]);
	assert.deepEqual(f.results, []);
	assert.equal(f.ue.running(), false);
	const again = fixture({ server: V72 });
	await again.ue.install();
	await again.done;
	assert.deepEqual(again.log, ["pin", `download ${V72}`, `install ${V72}`]);
});

test("the countdown restarts by itself when nobody answers", async () => {
	const f = fixture({ answers: [0, "wait"] });
	f.remote.onInstall = () => { f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; };
	await f.ue.install();
	await f.done;
	assert.deepEqual(f.log.at(-1), `install ${V72}`);
});

test("a failed download stops before the server is touched", async () => {
	const f = fixture({ downloadFails: true });
	await f.ue.install();
	await f.done;
	assert.equal(f.notices[0]!.detail, "Couldn’t download the app update. Nothing was changed.");
	assert.equal(f.requests.some((request) => request.method === "POST"), false);
	assert.deepEqual(f.failures, [], "not a server problem: no Retry screen");
});

test("refusals and old servers stop with a plain reason and leave the app alone", async () => {
	for (const [reply, expected] of [
		[{ status: 409, body: { error: "This server isn't run by the lh launcher, so it can't update itself." } }, /max-desktop can’t update: This server isn't run by the lh launcher/],
		[{ status: 404, body: {} }, /without Update everything\. Update it from its own Settings first/],
	] as const) {
		const f = fixture();
		f.remote.installReply = reply;
		await f.ue.install();
		await f.done;
		assert.match(f.failures[0]!, expected);
		assert.equal(f.log.some((entry) => entry.startsWith("install")), false);
		assert.deepEqual(f.results, []);
	}
});

test("a request with no answer may have started: the app keeps following the server and never says nothing changed", async () => {
	const f = fixture();
	f.remote.postTimeouts = 2;
	f.remote.onInstall = () => { f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; };
	await f.ue.install();
	await f.done;
	assert.deepEqual(f.failures, []);
	assert.deepEqual(f.log, ["pin", `download ${V72}`, `install ${V72}`], "the server updated under a lost answer, and the run followed it");

	const resent = fixture();
	resent.remote.postTimeouts = 1;
	resent.remote.startsAnyway = false;
	resent.remote.onInstall = () => { resent.remote.running = V72; resent.remote.health = V72; resent.remote.instance = "new"; };
	await resent.ue.install();
	await resent.done;
	assert.equal(resent.requests.filter((request) => request.path === "/api/updates/install-version").length, 2, "a request that never arrived is sent again on the next poll");
	assert.equal(resent.log.at(-1), `install ${V72}`);

	const lost = fixture();
	lost.remote.postTimeouts = Number.POSITIVE_INFINITY;
	lost.remote.startsAnyway = false;
	await lost.ue.install();
	await lost.done;
	assert.equal(lost.failures[0], "Couldn’t reach max-desktop for 32 minutes. Your app wasn’t changed.");
	assert.doesNotMatch(lost.failures[0]!, /Nothing was changed/, "the server may have got it");
	assert.equal(lost.log.some((entry) => entry.startsWith("install")), false);

	const proxy = fixture();
	proxy.remote.installReply = { status: 502, body: {} };
	proxy.remote.tick = () => { proxy.remote.installReply = null; };
	proxy.remote.onInstall = () => { proxy.remote.running = V72; proxy.remote.health = V72; proxy.remote.instance = "new"; };
	await proxy.ue.install();
	await proxy.done;
	assert.deepEqual(proxy.failures, [], "a 502 from the proxy is asked again, not a refusal");
	assert.equal(proxy.log.at(-1), `install ${V72}`);
});

test("after a switch to another server the relaunch reopens the open one, and the notice names the updated one", async () => {
	const B = "https://two.example.test";
	const f = fixture({ answers: [0, "wait"] });
	f.remote.onInstall = () => { f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; f.remote.selected = B; };
	await f.ue.install();
	await f.done;
	assert.equal((f.results[0] as { server: string }).server, B);
	assert.equal((f.results[0] as { updated: string }).updated, ORIGIN);
	const relaunch = createUpdateEverything({ appVersion: V71, takeResult: () => f.results[0], now: () => (f.results[0] as { savedAt: number }).savedAt, updater: { state: () => ({}) } });
	assert.deepEqual(relaunch.takeLaunch(), { server: B, retry: { target: V72, server: B, updated: ORIGIN } });
});

test("a launcher rejection, a rollback and the 32-minute limit fail the server step", async () => {
	const rejected = fixture();
	rejected.remote.onInstall = () => {
		// An older error state alone is not this run's failure; `pinned` is.
		rejected.remote.status = "error";
		rejected.remote.message = "Couldn’t check for updates.";
		rejected.remote.tick = () => { rejected.remote.pinned = { ...(rejected.remote.pinned as object), error: "Not enough disk space to back up your data." }; };
	};
	await rejected.ue.install();
	await rejected.done;
	assert.equal(rejected.failures[0], "max-desktop couldn’t start the update: Not enough disk space to back up your data. Your app wasn’t changed.");

	const rolled = fixture();
	rolled.remote.onInstall = () => {
		rolled.remote.instance = "back";
		rolled.remote.status = "error";
		rolled.remote.notice = { kind: "rolled-back", version: V72, text: "x", at: 1 };
	};
	await rolled.ue.install();
	await rolled.done;
	assert.equal(rolled.failures[0], `max-desktop couldn’t start ${V72} and went back to ${V71}. Your app wasn’t changed.`);

	const slow = fixture();
	slow.remote.onInstall = () => { slow.remote.down = true; };
	await slow.ue.install();
	await slow.done;
	assert.equal(slow.failures[0], "max-desktop wasn’t back after 32 minutes. Your app wasn’t changed.");
	assert.equal(slow.log.some((entry) => entry.startsWith("install")), false);
});

test("status passes the offered version's release notes through to the remote page, and reads a state without them as none", () => {
	const notes = [{ version: V72, items: ["**Cards.** Practice with cards."], totalItems: 1, stats: "3 changes from 1 contributor", footer: "Plus 2 more bug fixes." }, { version: V71, items: ["Older"], totalItems: 1 }];
	let appState: Record<string, unknown> = { status: "available", version: V72, releaseNotes: notes, omittedReleaseCount: 3 };
	const ue = createUpdateEverything({ appVersion: V71, updater: { state: () => appState } });
	assert.deepEqual(ue.status(), { version: V71, target: V72, phase: "available", error: null, downloadPercent: null, releaseNotes: notes, omittedReleaseCount: 3, run: null, result: null, serverOnly: true });
	appState = { status: "downloading", version: V72, downloadPercent: 40, releaseNotes: notes, omittedReleaseCount: 0 };
	assert.deepEqual(ue.status().releaseNotes, notes);
	assert.equal(ue.status().downloadPercent, 40);
	// A state without notes (an updater snapshot before any offer, or a malformed count) reads as none.
	appState = { status: "up-to-date", version: null, omittedReleaseCount: -2 };
	assert.deepEqual(ue.status(), { version: V71, target: null, phase: "up-to-date", error: null, downloadPercent: null, releaseNotes: [], omittedReleaseCount: 0, run: null, result: null, serverOnly: true });
	appState = { status: "available", version: V72, releaseNotes: "not a list", omittedReleaseCount: 1.5 };
	assert.deepEqual([ue.status().releaseNotes, ue.status().omittedReleaseCount], [[], 0]);
});

test("a run sends no notes, also in its download step and the app-only retry's, which the page can't tell from a plain download", async () => {
	const appNotes = [{ version: V72, items: ["App change"], totalItems: 1 }];
	const seen: Array<{ phase: string; releaseNotes: unknown[] }> = [];
	let ue: ReturnType<typeof fixture>["ue"] | null = null;
	const f = fixture({ appNotes, duringDownload: () => { const { phase, releaseNotes } = ue!.status(); seen.push({ phase, releaseNotes }); } });
	ue = f.ue;
	assert.deepEqual(f.ue.status().releaseNotes, appNotes, "before the run: this app's notes");
	f.remote.onInstall = () => { f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; };
	await f.ue.install();
	await f.done;
	assert.deepEqual(seen, [{ phase: "downloading", releaseNotes: [] }]);

	const saved = { savedAt: 1_000_000 - 1000, server: ORIGIN, updated: ORIGIN, from: V71, target: V72 };
	const seenRetry: Array<{ phase: string; releaseNotes: unknown[] }> = [];
	let retryUe: ReturnType<typeof fixture>["ue"] | null = null;
	const r = fixture({ saved, appNotes, answers: [0], duringDownload: () => { const { phase, releaseNotes } = retryUe!.status(); seenRetry.push({ phase, releaseNotes }); } });
	retryUe = r.ue;
	await r.ue.offerRetry(r.ue.takeLaunch()!.retry);
	await r.done;
	assert.deepEqual(seenRetry, [{ phase: "downloading", releaseNotes: [] }]);
});

test("status forwards only the notes' rendered fields, each validated and bounded", () => {
	const long = "x".repeat(5000);
	const groups = [
		{ version: V73, releasedAt: "2026-11-18T09:37:13.265Z", items: [`  ${long}  `, "", 7, "**Cards.** Practice   with cards."], extra: long, totalItems: 99, stats: "12 changes from 2 contributors", footer: "Plus 3 more bug fixes.", intro: long },
		{ version: V72, releasedAt: long, items: ["a"], stats: long, footer: 7, totalItems: 1e9, intro: "  A short   paragraph. " },
		{ version: V71, releasedAt: "yesterday", items: Array.from({ length: 20 }, (_, i) => `item ${i}`) },
		{ version: `${V71}${"9".repeat(100)}`, items: ["too long a version"] },
		{ version: "not a version", items: ["x"] },
		{ version: "0.6.1-nightly.20261118.70", releasedAt: "2026-11-18", items: ["kept day"] },
		...Array.from({ length: 10 }, (_, i) => ({ version: `0.6.1-nightly.20261117.${i + 1}`, items: ["older"] })),
	];
	const ue = createUpdateEverything({ appVersion: V71, updater: { state: () => ({ status: "available", version: V73, releaseNotes: groups, omittedReleaseCount: 1e9 }) } });
	const { releaseNotes, omittedReleaseCount } = ue.status() as { releaseNotes: Array<{ version: string; releasedAt?: string; items: string[]; totalItems: number }>; omittedReleaseCount: number };
	assert.equal(releaseNotes.length, 6, "at most 6 groups");
	assert.deepEqual(Object.keys(releaseNotes[0]!), ["version", "releasedAt", "items", "totalItems", "stats", "footer"], "only what the page renders");
	assert.deepEqual([releaseNotes[0]!.totalItems, (releaseNotes[0] as { stats?: string }).stats, (releaseNotes[0] as { footer?: string }).footer], [99, "12 changes from 2 contributors", "Plus 3 more bug fixes."]);
	assert.equal((releaseNotes[0] as { intro?: string }).intro, undefined, "an unbounded intro is dropped");
	const second = releaseNotes[1] as { stats?: string; footer?: string; intro?: string; totalItems: number };
	assert.deepEqual([second.stats, second.footer, second.intro, second.totalItems], [undefined, undefined, "A short paragraph.", 10000], "bad summary fields go, the count is bounded");
	assert.equal(releaseNotes[0]!.releasedAt, "2026-11-18T09:37:13.265Z");
	assert.equal(releaseNotes[0]!.items.length, 2);
	assert.ok(releaseNotes[0]!.items[0]!.length <= 220 && releaseNotes[0]!.items[0]!.endsWith("..."), "items are cut at 220 characters");
	assert.equal(releaseNotes[0]!.items[1], "**Cards.** Practice with cards.");
	assert.equal(releaseNotes[1]!.releasedAt, undefined, "an unbounded date is dropped");
	assert.equal(releaseNotes[2]!.releasedAt, undefined, "a date that isn't one is dropped");
	assert.equal(releaseNotes[2]!.items.length, 8, "at most 8 items");
	assert.deepEqual(releaseNotes.map((group) => group.version).slice(3), ["0.6.1-nightly.20261118.70", "0.6.1-nightly.20261117.1", "0.6.1-nightly.20261117.2"], "bad versions are skipped");
	assert.equal(releaseNotes[3]!.releasedAt, "2026-11-18");
	assert.equal(omittedReleaseCount, 1000, "the count is bounded too");
});

test("status reports the run, and a second click while the dialog is open is ignored", async () => {
	const f = fixture({ answers: [0, 1] });
	assert.deepEqual(f.ue.status(), { version: V71, target: V72, phase: "available", error: null, downloadPercent: null, releaseNotes: [], omittedReleaseCount: 0, run: null, result: null, serverOnly: true });
	let phaseWhileUpdating: unknown;
	f.remote.onInstall = () => {
		phaseWhileUpdating = f.ue.status().phase;
		f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new";
	};
	await Promise.all([f.ue.install(), f.ue.install()]);
	await f.done;
	assert.equal(f.prompts.filter((prompt) => prompt.message === "Update everything?").length, 1);
	assert.equal(phaseWhileUpdating, "updating");
	assert.equal(f.ue.running(), false);
	f.ue.check();
	assert.deepEqual(f.log.slice(-1), ["check"]);
});

const until = async (condition: () => boolean) => {
	// The countdown's own (shortened) timer is real, so wait in short real steps.
	for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
	assert.ok(condition(), "timed out waiting");
};

test("an app install that fails after the server committed offers the app-only retry of the pinned version", async () => {
	const f = fixture({ answers: [0, "wait", 0] });
	f.remote.installFails = 2;
	f.remote.onInstall = () => { f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; };
	await f.ue.install();
	await until(() => f.notices.length > 0);
	assert.ok(f.log.includes(`reconnect ${ORIGIN}`), "the ghost cover goes away");
	const retry = f.prompts.at(-1)!;
	assert.equal(retry.message, "The app update didn’t finish.");
	assert.equal(retry.detail, `LearnHarness is still on ${V71} and max-desktop is on ${V72}. Install LearnHarness ${V72} again? Only this app restarts.`);
	assert.deepEqual(retry.buttons, ["Try Again", "Later"]);
	assert.deepEqual(f.log, ["pin", `download ${V72}`, `install ${V72} failed`, `reconnect ${ORIGIN}`, `exact ${V72}`, `install ${V72} failed`]);
	assert.deepEqual(f.notices.at(-1), { message: "Couldn’t install the app update.", detail: `LearnHarness is still on ${V71} and max-desktop is on ${V72}. Use Update everything to try again.` }, "the owner's wording: not the menu, which installs the newest version");
	assert.equal(f.requests.filter((request) => request.path === "/api/updates/install-version").length, 1, "the retry never touches the server");
	assert.deepEqual(f.failures, []);
	assert.equal(f.ue.takeLaunch(), null, "offered once: nothing saved for the next launch");
});

test("an installer error main recovers from ends a run waiting on its install, with the app-only retry, so a second install works", async () => {
	const f = fixture({ answers: [0, "wait", 1] });
	f.remote.onInstall = () => { f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; };
	await f.ue.install();
	await f.done;
	assert.deepEqual(f.log.slice(-1), [`install ${V72}`]);
	assert.equal(f.ue.running(), true, "waiting on the app install: Restarting");
	assert.equal(f.ue.status().phase, "updating");
	f.ue.installFailed();
	await until(() => f.prompts.some((prompt) => prompt.message === "The app update didn’t finish."));
	assert.ok(f.log.includes(`reconnect ${ORIGIN}`), "the server's new page shows again");
	await until(() => !f.ue.running());
	assert.notEqual(f.ue.status().phase, "updating", "no longer Restarting");
	assert.equal(f.ue.takeLaunch(), null, "nothing saved for a relaunch that won't come");
	f.ue.installFailed();
	assert.equal(f.prompts.filter((prompt) => prompt.message === "The app update didn’t finish.").length, 1, "once");
});

test("after a relaunch the retry installs the pinned version, even once the feed has moved on", async () => {
	const saved = { savedAt: 1_000_000 - 1000, server: ORIGIN, updated: ORIGIN, from: V71, target: V72 };
	const f = fixture({ saved, offered: V73, answers: [0] });
	const launch = f.ue.takeLaunch()!;
	assert.deepEqual(launch, { server: ORIGIN, retry: { target: V72, server: ORIGIN, updated: ORIGIN } });
	await f.ue.offerRetry(launch.retry);
	await f.done;
	assert.deepEqual(f.log, [`exact ${V72}`, `install ${V72}`], "V72, not the feed's newer V73, and no new pin");
	assert.equal(f.requests.length, 0, "no server request at all");
	assert.deepEqual(f.results[0], { savedAt: 1_000_000, server: ORIGIN, updated: ORIGIN, from: V71, target: V72, retried: true }, "marked as a Try Again");

	// That install fails too (Squirrel.Mac, NSIS or the AppImage reopening the old app):
	// the next launch reports it instead of offering Try Again again.
	const relaunched = fixture({ saved: f.results[0], answers: [0] });
	const next = relaunched.ue.takeLaunch()!;
	assert.deepEqual(next, { server: ORIGIN, retry: null, retryFailed: { target: V72, server: ORIGIN, updated: ORIGIN } });
	await relaunched.ue.afterLaunch(next);
	assert.equal(relaunched.prompts.length, 0, "no second Try Again");
	assert.deepEqual(relaunched.notices, [{ message: "Couldn’t install the app update.", detail: `LearnHarness is still on ${V71} and max-desktop is on ${V72}. Use Update everything to try again.` }]);
	assert.deepEqual(relaunched.log, []);
	assert.equal(relaunched.ue.takeLaunch(), null, "and the offer is gone");

	// A first-time miss still offers it, through the same launch hook.
	const first = fixture({ saved, answers: [1] });
	await first.ue.afterLaunch(first.ue.takeLaunch());
	assert.equal(first.prompts[0]!.message, "The app update didn’t finish.");

	const later = fixture({ saved, answers: [1] });
	await later.ue.offerRetry(later.ue.takeLaunch()!.retry);
	assert.deepEqual(later.log, [], "Later changes nothing");
	assert.equal(later.ue.running(), false);
});

test("a pinned error left from an earlier attempt is not this run's", async () => {
	const f = fixture();
	f.remote.pinned = { version: V72, error: "offline", id: "earlier" };
	f.remote.postTimeouts = 1;
	f.remote.startsAnyway = false;
	f.remote.onInstall = () => { f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; };
	await f.ue.install();
	await f.done;
	assert.deepEqual(f.failures, [], "the first poll sees the old error before any request arrived");
	assert.equal(f.log.at(-1), `install ${V72}`);
});

test("a route that keeps answering 5xx while the server answers as itself stops with that reason", async () => {
	const f = fixture();
	f.remote.installReply = { status: 500, body: {} };
	await f.ue.install();
	await f.done;
	assert.equal(f.failures[0], "max-desktop can’t update: HTTP 500. Nothing was changed.");
	assert.ok(f.requests.filter((request) => request.path === "/api/updates/install-version").length <= 3, "not 32 minutes of retries");
});

test("a notice keeps the page's install() waiting, so a page can't stack dialogs", async () => {
	let close: () => void = () => {};
	const f = fixture({ offered: null });
	const ue = createUpdateEverything({
		appVersion: V71,
		updater: { state: () => ({ status: "up-to-date", version: null }), check() {}, download() {}, pin: async () => null },
		selection: () => ({ origin: ORIGIN, token: "bearer" }),
		tell: (notice: { message: string; detail: string }) => { f.notices.push(notice); return new Promise<void>((resolve) => { close = resolve; }); },
	});
	const first = ue.install();
	await new Promise((resolve) => setImmediate(resolve));
	await ue.install();
	assert.equal(f.notices.length, 1, "a second call while the notice is open does nothing");
	close();
	await first;
	assert.equal(f.notices[0]!.message, "LearnHarness is up to date.");
});

test("the relaunch reopens that server once and offers the retry when the app didn't change", () => {
	const recent = { savedAt: 1_000_000 - 1000, server: ORIGIN, from: V71, target: V72 };
	const same = fixture({ saved: recent });
	assert.deepEqual(same.ue.takeLaunch(), { server: ORIGIN, retry: { target: V72, server: ORIGIN, updated: ORIGIN } });
	assert.equal(same.ue.takeLaunch(), null, "read once");
	const old = fixture({ saved: { ...recent, savedAt: 1_000_000 - SAVED_RESULT_MAX_AGE_MS - 1 } });
	assert.equal(old.ue.takeLaunch(), null, "a stale record is ignored, as in T3");
	const applied = createUpdateEverything({ appVersion: V72, takeResult: () => recent, now: () => 1_000_000, updater: { state: () => ({}) } });
	assert.deepEqual(applied.takeLaunch(), { server: ORIGIN, retry: null });
});

test("Settings' This app Install: T3's confirm in main, then only this app installs; Cancel, nothing downloaded or a run changes nothing", async () => {
	const make = ({ status = "downloaded" as string, answers = [0] as Array<number | "wait">, runFirst = false } = {}) => {
		const prompts: Prompt[] = [];
		const log: string[] = [];
		let release: () => void = () => {};
		const ue = createUpdateEverything({
			appVersion: V71,
			updater: {
				state: () => ({ status, version: V72, availableVersion: V72, downloadedVersion: status === "downloaded" ? V72 : null, errorContext: null }),
				install: () => log.push("install"),
				installPinned: (v: string) => log.push(`pinned ${v}`),
				pin: async () => V72, downloadPinned: async () => {}, check: () => {}, download: () => {},
			},
			selection: () => (runFirst ? { origin: ORIGIN, token: "bearer" } : null),
			request: async () => Response.json({ runningVersion: V71, committed: true, instance: "i", status: "up-to-date" }),
			confirm: async (prompt: Prompt) => {
				prompts.push(prompt);
				const answer = answers.shift() ?? 1;
				if (answer === "wait") return new Promise<number>((resolve) => { release = () => resolve(1); });
				return answer;
			},
			tell: async () => {}, now: () => 0,
		});
		return { ue, prompts, log, release: () => release() };
	};
	const yes = make();
	await yes.ue.installApp();
	assert.deepEqual(yes.prompts.map(({ message, detail, buttons }) => ({ message, detail, buttons })), [{
		message: `Install update ${V72} and restart LearnHarness?`,
		detail: "Any running tasks will be interrupted. Make sure you're ready before continuing.",
		buttons: ["Install and restart", "Cancel"],
	}], "T3's confirm, asked by the app itself");
	assert.deepEqual(yes.log, ["install"], "the plain install: only this app, no server request");
	assert.equal(yes.ue.running(), false);

	const no = make({ answers: [1] });
	await no.ue.installApp();
	assert.deepEqual(no.log, [], "Cancel installs nothing");

	const nothing = make({ status: "available" });
	await nothing.ue.installApp();
	assert.deepEqual([nothing.prompts.length, nothing.log], [0, []], "nothing downloaded: no confirm");

	const asking = make({ answers: ["wait"] });
	const pending = asking.ue.installApp();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(asking.ue.running(), true, "while it asks, Update everything and the plain install wait");
	await asking.ue.installApp();
	assert.equal(asking.prompts.length, 1, "a second click doesn't ask twice");
	asking.release();
	await pending;
	assert.equal(asking.ue.running(), false);
});

test("the bridge answers only the remote window's main frame at its origin, and takes no argument at all", async () => {
	const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
	const mainFrame = { url: `${ORIGIN}/learn/x` };
	const contents = { mainFrame };
	const win = { webContents: contents, isDestroyed: () => false };
	const calls: string[] = [];
	registerDesktopUpdateIPC({ handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) }, {
		current: () => ({ win, origin: ORIGIN }),
		pageGeneration: (of: unknown) => (of === win ? 3 : -1),
		updateEverything: {
			status: () => { calls.push("status"); return { phase: "idle" }; }, check: () => calls.push("check"), download: () => calls.push("download"),
			install: async (...args: unknown[]) => { calls.push(`install${args.length ? JSON.stringify(args) : ""}`); },
			installApp: async () => { calls.push("installApp"); return "never returned to the page"; },
			everything: async () => { calls.push("everything"); return { started: false }; },
			ready: (from: { win: unknown; generation: number }) => { calls.push(`ready ${from.win === win} ${from.generation}`); return "never returned"; }, later: () => { calls.push("later"); return "never returned"; },
			retry: async () => { calls.push("retry"); return { started: false }; },
			dismiss: () => { calls.push("dismiss"); return "never returned"; }, takeResult: () => { calls.push("takeResult"); return null; },
		},
	});
	const handle = handlers.get("lh:desktop-update")!;
	const own = { sender: contents, senderFrame: mainFrame };
	assert.deepEqual(await handle(own, "status"), { phase: "idle" });
	await handle(own, "install");
	assert.equal(await handle(own, "install-app"), undefined);
	assert.deepEqual(await handle(own, "everything"), { started: false });
	assert.deepEqual(await handle(own, "retry"), { started: false });
	for (const action of ["ready", "later", "dismiss"]) assert.equal(await handle(own, action), undefined, `${action} returns nothing to the page`);
	assert.equal(await handle(own, "take-result"), null);
	assert.deepEqual(calls, ["status", "install", "installApp", "everything", "retry", "ready true 3", "later", "dismiss", "takeResult"], "ready() says which window and page load it came from");
	calls.length = 0;
	// Hostile arguments from the page, including the dialog choice an earlier draft took: all refused.
	const PLAN_ID = "123e4567-e89b-42d3-a456-426614174000";
	const hostile: unknown[][] = [
		["install", { planId: PLAN_ID }],
		["install", V72],
		["install", { version: V72, url: "https://evil.example/app.dmg" }],
		["everything", { planId: PLAN_ID }], ["everything", V72],
		["retry", {}], ["ready", 1], ["later", "x"], ["dismiss", null], ["take-result", "x"], ["install-app", V72], ["status", true],
		["plan"], ["__proto__"], ["constructor"], [{ toString: () => "status" }],
	];
	for (const args of hostile) await assert.rejects(handle(own, ...args), /Untrusted desktop request/, JSON.stringify(args));
	const refused = [
		[{ sender: {}, senderFrame: mainFrame }, "status"],
		[{ sender: contents, senderFrame: { url: `${ORIGIN}/x` } }, "everything"],
		[{ sender: contents, senderFrame: { ...mainFrame } }, "install"],
	] as const;
	for (const [event, ...args] of refused) await assert.rejects(handle(event, ...args), /Untrusted desktop request/);
	mainFrame.url = "https://evil.example/";
	await assert.rejects(handle({ sender: contents, senderFrame: mainFrame }, "everything"), /Untrusted/);
	assert.deepEqual(calls, [], "none of them reached main's run");
});

test("the remote preload exposes only window.lh.desktopUpdate and window.lh.chatgptSignIn, forwards no argument, and asks only from a click", async () => {
	const source = fs.readFileSync(path.join(import.meta.dirname, "..", "electron", "remote-preload.cjs"), "utf8");
	const exposed = new Map<string, unknown>();
	const invoked: unknown[][] = [];
	const run = (protocol: string) => new Function("require", "location", source)((name: string) => {
		assert.equal(name, "electron");
		return {
			contextBridge: { exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value) },
			ipcRenderer: { invoke: (...args: unknown[]) => { invoked.push(args); return Promise.resolve(); } },
		};
	}, { protocol });
	run("file:");
	assert.deepEqual([...exposed.keys()], [], "the ghost dashboard page gets nothing");
	run("https:");
	assert.deepEqual([...exposed.keys()], ["lh"]);
	const lh = exposed.get("lh") as { desktopUpdate: Record<string, (...args: unknown[]) => unknown> };
	assert.deepEqual(Object.keys(lh), ["desktopUpdate", "chatgptSignIn"]);
	const methods = ["getStatus", "check", "download", "install", "installApp", "everything", "ready", "later", "retry", "dismiss", "takeResult"];
	assert.deepEqual(Object.keys(lh.desktopUpdate), methods);
	// Asking for a dialog needs the user's own click or key press in the page.
	const activation = { isActive: false };
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userActivation: activation } });
	try {
		for (const method of ["install", "everything", "retry"]) {
			const refused = lh.desktopUpdate[method]!() as Promise<unknown>;
			await assert.rejects(refused, /only from a click/, method);
		}
		assert.deepEqual(invoked.splice(0), [], "a script alone asks for nothing");
		activation.isActive = true;
		for (const method of methods) lh.desktopUpdate[method]!({ planId: "123e4567-e89b-42d3-a456-426614174000" }, "0.0.1-evil", "https://evil.example");
	} finally {
		if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
		else delete (globalThis as { navigator?: unknown }).navigator;
	}
	assert.deepEqual(invoked.splice(0), [
		["lh:desktop-update", "status"], ["lh:desktop-update", "check"], ["lh:desktop-update", "download"], ["lh:desktop-update", "install"],
		["lh:desktop-update", "install-app"], ["lh:desktop-update", "everything"], ["lh:desktop-update", "ready"], ["lh:desktop-update", "later"],
		["lh:desktop-update", "retry"], ["lh:desktop-update", "dismiss"], ["lh:desktop-update", "take-result"],
	], "arguments from the page are never forwarded");
	const signIn = (lh as unknown as { chatgptSignIn: Record<string, (...args: unknown[]) => unknown> }).chatgptSignIn;
	assert.deepEqual(Object.keys(signIn), ["start", "cancel"]);
	signIn.start!();
	signIn.start!("account-id", "https://evil.example", "extra");
	signIn.cancel!("https://evil.example");
	assert.deepEqual(invoked, [["lh:chatgpt-sign-in", "start"], ["lh:chatgpt-sign-in", "start", "account-id"], ["lh:chatgpt-sign-in", "cancel"]], "at most the one account id, which main checks");
});

test("a run names the server it updates from its confirmation to its end, so the list can hold that server", async () => {
	const f = fixture({ answers: [0, 1] });
	assert.equal(f.ue.server(), null);
	let duringUpdate: unknown;
	f.remote.onInstall = () => {
		duringUpdate = f.ue.server();
		f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new";
	};
	await f.ue.install();
	await f.done;
	assert.equal(duringUpdate, ORIGIN);
	await until(() => f.ue.server() === null);
	const cancelled = fixture({ answers: [1] });
	await cancelled.ue.install();
	await until(() => cancelled.ue.server() === null);
});


// ─── Revision PR 7: main's own dialog, the page's capsule ─────────────────────

type View = { version: string; rows: unknown[]; skipped: unknown[]; running: number; disabledReason: string | null };
type RunView = { phase: string; localVersion: string | null; restartAt: number | null; awaitingPage: boolean; keyboard: boolean; machines: Array<{ label: string; status: string; startedAt: number; failure: string | null }> };
const runOf = (f: ReturnType<typeof fixture>) => (f.ue.status() as { run: RunView | null }).run;
const resultOf = (f: ReturnType<typeof fixture>) => (f.ue.status() as { result: number | null }).result;
const viewOf = (f: ReturnType<typeof fixture>, at = 0) => f.asked[at]!.plan as View;
/** A failed run kept for the capsule: the server rolled back. */
async function failedRun(options: Parameters<typeof fixture>[0] = {}) {
	const f = fixture({ expectReconnect: null, ...options });
	f.remote.onInstall = () => {
		f.remote.instance = "back";
		f.remote.status = "error";
		f.remote.notice = { kind: "rolled-back", version: V72, text: "x", at: 1 };
	};
	await f.ue.everything();
	await until(() => runOf(f)?.machines[0]?.status === "failed");
	return f;
}

test("only main's own dialog starts a run: the page's calls alone never do, a recent click or not", async () => {
	const f = fixture({ inApp: ["wait"] });
	const opening = f.ue.everything();
	await until(() => f.asked.length === 1);
	// The page keeps calling while the dialog is open (a compromised page, a user typing).
	assert.deepEqual(await f.ue.everything(), { error: { title: "Update everything", detail: "Update everything is already running." } });
	assert.deepEqual(await f.ue.retry(), { error: { title: "Update everything", detail: "Update everything is already running." } }, "busy, said in the page's toast");
	f.ready();
	f.ue.later();
	assert.equal(f.ue.server(), null, "only the dialog is open: no hold on the server yet");
	assert.equal(runOf(f), null);
	assert.equal(f.ue.running(), true, "the dialog holds the slot");
	assert.equal(f.requests.some((request) => request.method === "POST"), false, "nothing changed on the server");
	assert.deepEqual(f.log, ["pin"], "nothing downloaded");
	f.answer(false);
	assert.deepEqual(await opening, { started: false, keyboard: false, dialog: true }, "Cancel in main's dialog");
	assert.equal(f.asked.length, 1, "asked once");
	assert.equal(f.ue.running(), false);
	assert.equal(runOf(f), null);
	assert.equal(f.prompts.length, 0);
});

test("after a Cancel the page can't ask again at once: a script can't keep putting the dialog up", async () => {
	const f = fixture({ inApp: [false, false] });
	assert.deepEqual(await f.ue.everything(), { started: false, keyboard: false, dialog: true });
	assert.deepEqual(await f.ue.everything(), { error: { title: "Update everything", detail: "Try again in a moment." } }, "refused, with a reason the page can show");
	assert.equal(f.asked.length, 1, "no second dialog");
	f.advance(ASK_COOLDOWN_MS);
	assert.deepEqual(await f.ue.everything(), { started: false, keyboard: false, dialog: true });
	assert.equal(f.asked.length, 2, "it asks again later");
	// The native confirmation's Cancel counts too.
	const native = fixture({ answers: [1] });
	await native.ue.install();
	await native.ue.install();
	assert.equal(native.prompts.length, 1);
});

test("main's native confirmations default to Cancel: Enter or Escape changes nothing", async () => {
	for (const server of [V71, V72]) {
		const f = fixture({ server, answers: [1] });
		await f.ue.install();
		const prompt = f.prompts[0] as Prompt & { defaultId?: number; cancelId?: number };
		assert.equal(prompt.buttons[prompt.defaultId!], "Cancel", `${server}: the default`);
		assert.equal(prompt.buttons[prompt.cancelId!], "Cancel");
	}
	const { installAppConfirmation } = require("../electron/update-everything.cjs");
	const app = installAppConfirmation(V72);
	assert.equal(app.buttons[app.defaultId], "Cancel");
});

test("main's dialog shows the plan: the server first, This app last, its running work", async () => {
	const f = fixture({ inApp: [false] });
	await f.ue.everything();
	assert.deepEqual(viewOf(f), { version: V72, rows: [{ label: "max-desktop", app: "server", running: 2 }, { label: "This app", app: "this-app", running: 0 }], running: 2, skipped: [], disabledReason: null });
	assert.equal(f.asked[0]!.win, f.remote.win, "over the server's own window");
	const appOnly = fixture({ server: V72, inApp: [false] });
	await appOnly.ue.everything();
	assert.deepEqual(viewOf(appOnly).rows, [{ label: "This app", app: "this-app", running: 0 }]);
	assert.equal(viewOf(appOnly).running, 0, "an app restart stops no server work: no running list (owner, PR 3)");
	assert.match((await fixture({ server: V73 }).ue.everything() as { error: { detail: string } }).error.detail, /runs 0\.6\.1-nightly\.20261118\.73, newer than this app’s update/);
	assert.equal((await fixture({ offered: null }).ue.everything() as { error: { title: string } }).error.title, "LearnHarness is up to date.");
	// A server that can't update itself is skipped; Update can't start anything even if pressed.
	const manual = fixture({ inApp: [true] });
	manual.remote.status = "disabled";
	manual.remote.message = "Installed with Docker: update the image.";
	assert.deepEqual(await manual.ue.everything(), { started: false, keyboard: false, dialog: true });
	assert.deepEqual(viewOf(manual).skipped, [{ label: "max-desktop", reason: "Installed with Docker: update the image." }]);
	assert.equal(viewOf(manual).disabledReason, "Update max-desktop from its own Settings first.");
	assert.equal(runOf(manual), null);
});

test("a dialog belongs to its window: one closed and opened again on the same server can't use it", async () => {
	const f = fixture({ inApp: ["wait"] });
	const opening = f.ue.everything();
	await until(() => f.asked.length === 1);
	f.remote.win = { id: 2 }; // the same server, a new window
	f.answer(true);
	assert.deepEqual(await opening, { started: false, keyboard: false, dialog: true });
	assert.equal(runOf(f), null);
	assert.equal(f.log.includes(`download ${V72}`), false);
});

test("one dialog at a time, the run reserved before any wait, and a hold released only by whoever took it", async () => {
	const f = fixture({ inApp: [true], countdown: new AbortController() });
	f.remote.onInstall = () => { f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; };
	const [first, second] = await Promise.all([f.ue.everything(), f.ue.everything()]);
	assert.deepEqual([first, second], [{ started: true, keyboard: false, dialog: true }, { error: { title: "Update everything", detail: "Update everything is already running." } }]);
	assert.equal(f.asked.length, 1, "asked once");
	await until(() => runOf(f)?.phase === "countdown");
	assert.equal(f.ue.server(), ORIGIN, "the run holds its server");
	assert.deepEqual(await f.ue.everything(), { error: { title: "Update everything", detail: "Update everything is already running." } });
	assert.deepEqual(await f.ue.retry(), { error: { title: "Update everything", detail: "Update everything is already running." } });
	assert.equal(f.ue.server(), ORIGIN, "calls that changed nothing released nothing");
	f.ue.later();
	await until(() => f.ue.server() === null);

	// Retry reserves too: a second Retry, or the everything control, waits for its dialog.
	const kept = await failedRun({ inApp: [true, "wait"] });
	const retrying = kept.ue.retry();
	assert.deepEqual(await kept.ue.retry(), { error: { title: "Update everything", detail: "Update everything is already running." } });
	assert.deepEqual(await kept.ue.everything(), { error: { title: "Update everything", detail: "Update everything is already running." } });
	await until(() => kept.asked.length === 2);
	assert.equal(kept.ue.server(), null, "Retry's dialog holds nothing either");
	kept.answer(false);
	assert.deepEqual(await retrying, { started: false, keyboard: false, dialog: true });
	assert.equal(kept.asked.length, 2);
});

test("Retry checks again: a server now newer than the target, or one that can't update itself, isn't retried", async () => {
	const newer = await failedRun();
	newer.remote.running = V73;
	newer.remote.notice = null;
	const answer = await newer.ue.retry() as { error: { detail: string } };
	assert.match(answer.error.detail, /runs 0\.6\.1-nightly\.20261118\.73, newer than this app’s update/);
	assert.equal(newer.asked.length, 1, "no dialog for it");
	assert.equal(runOf(newer)!.machines[0]!.failure, `max-desktop couldn’t start ${V72} and went back to ${V71}. Your app wasn’t changed.`, "the capsule keeps the run's own failure; the toast says why Retry didn't start");

	const manual = await failedRun();
	manual.remote.status = "disabled";
	assert.equal((await manual.ue.retry() as { error: { detail: string } }).error.detail, "Update max-desktop from its own Settings first.");
	assert.equal(manual.asked.length, 1);
});

test("Retry updates only the failed server, as T3 does: this app stays as it is", async () => {
	const f = await failedRun({ inApp: [true, true] });
	f.remote.notice = null;
	f.remote.status = "idle";
	f.remote.pinned = null;
	f.remote.onInstall = () => { f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; };
	assert.deepEqual(await f.ue.retry(), { started: true, keyboard: false, dialog: true });
	assert.deepEqual(viewOf(f, 1).rows, [{ label: "max-desktop", app: "server", running: 2 }], "main's dialog asks for the server only");
	await until(() => runOf(f) === null && resultOf(f) !== null);
	assert.equal(f.log.some((entry) => entry.startsWith("install")), false, "no app restart");
	assert.deepEqual(f.ue.takeResult(), { localVersion: null, updatedServers: 1, failures: [] });

	// Back on the target by the time of Retry: done, no dialog.
	const back = await failedRun();
	back.remote.running = V72;
	back.remote.notice = null;
	assert.deepEqual(await back.ue.retry(), { started: false });
	assert.equal(back.asked.length, 1);
	assert.equal(runOf(back), null);
	assert.deepEqual(back.ue.takeResult(), { localVersion: null, updatedServers: 1, failures: [] });
});

test("nothing restarts, and nothing is covered, before the server was asked", async () => {
	const f = fixture({ expectReconnect: null });
	f.remote.installReply = { status: 409, body: { error: "Another update is running." } };
	await f.ue.everything();
	await until(() => runOf(f)?.machines[0]?.status === "failed");
	assert.deepEqual(f.progress, [], "no cover for a refusal");
	assert.deepEqual(f.reconnects, [], "nothing to show again, and no version claimed as reloaded");
	assert.equal(runOf(f)!.machines[0]!.failure, "max-desktop can’t update: Another update is running. Nothing was changed.");
});

test("the 5 s countdown starts only once the page shows it; a page that never does gets main's own countdown", async () => {
	const countdown = new AbortController();
	const f = fixture({ server: V72, page: "manual", countdown });
	await f.ue.everything();
	await until(() => runOf(f)?.phase === "countdown");
	assert.equal(runOf(f)!.restartAt, null, "not counting yet");
	assert.equal(runOf(f)!.awaitingPage, true, "main waits for the page");
	f.ready();
	await until(() => runOf(f)?.restartAt !== null);
	assert.equal(runOf(f)!.restartAt, f.now() + RESTART_DELAY_MS, "the user's full 5 s, from when the page shows it");
	assert.equal(runOf(f)!.awaitingPage, false);
	f.ue.later();
	await until(() => runOf(f) === null);
	assert.equal(f.prompts.length, 0);

	const old = fixture({ server: V72, page: "none", answers: [1] });
	await old.ue.everything();
	await until(() => old.prompts.length === 1);
	assert.deepEqual(old.prompts[0]!.buttons, ["Restart now", "Later"], "main's native countdown, with its Later");
	assert.ok(old.prompts[0]!.signal);
	await until(() => runOf(old) === null);
	assert.equal(old.log.some((entry) => entry.startsWith("install")), false, "Later there too");
});

test("an in-page run: the capsule's steps, the cover only while the server restarts, then the countdown and Later", async () => {
	const countdown = new AbortController();
	const f = fixture({ countdown });
	const seen: string[] = [];
	let polls = 0;
	f.remote.onInstall = () => {
		f.remote.tick = () => {
			polls++;
			seen.push(`${runOf(f)?.machines[0]?.status} cover=${f.progress.length}`);
			if (polls === 2) f.remote.down = true;
			if (polls === 4) { f.remote.down = false; f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; }
		};
	};
	assert.deepEqual(await f.ue.everything(), { started: true, keyboard: false, dialog: true });
	await until(() => runOf(f)?.restartAt !== null && runOf(f)?.phase === "countdown");
	assert.deepEqual(seen.slice(0, 2), ["downloading cover=0", "downloading cover=0"], "staging: the page stays in view, with the capsule");
	assert.ok(seen.includes("restarting cover=1"), "restarting: the ghost cover goes up");
	assert.deepEqual(f.progress, [`Updating max-desktop to ${V72}… This can take a few minutes.`], "covered once");
	assert.deepEqual(f.reconnects, [V72], "back on the target: the page shows again");
	assert.deepEqual(runOf(f)!.machines.map(({ label, status, failure }) => ({ label, status, failure })), [{ label: "max-desktop", status: "done", failure: null }]);
	assert.equal(f.prompts.length, 0, "Restart in 5s is the page's, not a native dialog");
	f.ue.later();
	await until(() => runOf(f) === null);
	assert.equal(f.log.some((entry) => entry.startsWith("install")), false, "Later: this app stays as it is");
	const id = resultOf(f);
	assert.equal(typeof id, "number");
	assert.deepEqual(f.ue.takeResult(), { localVersion: null, updatedServers: 1, failures: [] });
	assert.equal(f.ue.takeResult(), null, "read once");
	assert.equal(resultOf(f), null);
});

test("the countdown restarts by itself: Restarting…, and the result toast waits for the page after the relaunch", async () => {
	const f = fixture({ server: V72 });
	await f.ue.everything();
	await f.done;
	assert.equal(runOf(f)?.phase, "installing");
	assert.deepEqual(f.log, ["pin", `download ${V72}`, `install ${V72}`]);
	const record = f.results[0] as Record<string, unknown>;
	assert.equal(record.inPage, true);
	const next = fixture({ saved: record, appVersion: V72 });
	next.ue.takeLaunch();
	assert.equal(typeof resultOf(next), "number");
	assert.deepEqual(next.ue.takeResult(), { localVersion: V72, updatedServers: 0, failures: [] });
	const legacy = fixture({ saved: { ...record, inPage: undefined }, appVersion: V72 });
	legacy.ue.takeLaunch();
	assert.equal(legacy.ue.takeResult(), null, "an older run leaves no toast");
});

test("a failure stays in the capsule on its own server; a second failure is a new result; Dismiss forgets it", async () => {
	const f = await failedRun();
	const message = `max-desktop couldn’t start ${V72} and went back to ${V71}. Your app wasn’t changed.`;
	assert.deepEqual(runOf(f)!.machines.map(({ status, failure }) => ({ status, failure })), [{ status: "failed", failure: message }]);
	assert.equal(runOf(f)!.localVersion, null);
	assert.deepEqual(f.failures, [], "the page shows it, not the server list");
	assert.deepEqual(f.reconnects, [V71], "covered while it restarted, then shown again on the version it went back to");
	const first = resultOf(f);
	f.remote.selected = "https://other.example.test";
	assert.equal(runOf(f), null, "another server's page doesn't show it");
	f.remote.selected = ORIGIN;
	f.ue.dismiss();
	assert.equal(runOf(f), null);
	assert.notEqual(first, null);

	// A quick Retry that fails again gets its own result number, so its toast isn't lost.
	const again = await failedRun({ inApp: [true, true] });
	const before = resultOf(again);
	again.remote.installReply = { status: 409, body: { error: "Another update is running." } };
	await again.ue.retry();
	await until(() => runOf(again)?.machines[0]?.status === "failed" && resultOf(again) !== before);
	assert.notEqual(resultOf(again), before);
});

test("a rollback to a page that can't show the capsule falls back to the server list, with its Retry", async () => {
	const f = fixture({ expectReconnect: null, page: "none" });
	f.remote.onInstall = () => {
		f.remote.instance = "back";
		f.remote.status = "error";
		f.remote.notice = { kind: "rolled-back", version: V72, text: "x", at: 1 };
	};
	await f.ue.everything();
	await until(() => f.failures.length === 1);
	assert.equal(f.failures[0], `max-desktop couldn’t start ${V72} and went back to ${V71}. Your app wasn’t changed.`);
	assert.deepEqual(f.kinds, ["retry"]);
	assert.equal(runOf(f), null, "nothing left the page can't show");
	assert.equal(f.ue.takeResult(), null);
});

test("an in-page run whose server never comes back shows the problem in the server list", async () => {
	const f = fixture({ expectReconnect: null });
	f.remote.onInstall = () => { f.remote.down = true; };
	await f.ue.everything();
	await f.done;
	assert.deepEqual(f.failures, ["max-desktop wasn’t back after 32 minutes. Your app wasn’t changed."]);
	assert.equal(runOf(f), null);
});

/** An in-page run whose server is covered while it restarts, then shown again (reconnect). */
function coveredRun(options: Parameters<typeof fixture>[0] = {}) {
	const f = fixture(options);
	f.remote.onInstall = () => {
		f.remote.instance = "new";
		f.remote.tick = () => { f.remote.running = V72; f.remote.health = V72; };
	};
	return f;
}

test("after the cover, only the reloaded page can say it shows the countdown, and the 10 s start once it has loaded", async () => {
	const f = coveredRun({ page: "manual", countdown: new AbortController() });
	f.remote.holdLoad = true;
	assert.deepEqual(await f.ue.everything(), { started: true, keyboard: false, dialog: true });
	await until(() => runOf(f)?.phase === "countdown");
	assert.deepEqual(f.reconnects, [V72]);
	assert.equal(f.page.clocks, 0, "the wait's clock waits for the new page to load");
	// The page from before the reload still polls and answers: not the page that will show it.
	f.ready();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(runOf(f)!.restartAt, null, "the old page's answer doesn't count");
	f.loadPage();
	await until(() => f.page.clocks === 1);
	assert.equal(runOf(f)!.awaitingPage, true);
	f.ready();
	await until(() => runOf(f)?.restartAt !== null);
	assert.equal(runOf(f)!.restartAt, f.now() + RESTART_DELAY_MS);
	f.ue.later();
	await until(() => runOf(f) === null);
});

test("a page that already reloaded itself under the cover answers at once", async () => {
	const f = coveredRun({ page: "manual", countdown: new AbortController() });
	f.remote.reloads = false;
	await f.ue.everything();
	await until(() => runOf(f)?.awaitingPage === true);
	assert.equal(f.page.clocks, 1, "nothing to wait for: the page is the new one");
	f.ready();
	await until(() => runOf(f)?.restartAt !== null);
	f.ue.later();
	await until(() => runOf(f) === null);
});

test("waiting for the page to show a failure: no hold on the server, and Dismiss or a closed window ends the wait without the server list", async () => {
	const dismissed = await failedRun({ page: "manual" });
	await until(() => runOf(dismissed)?.awaitingPage === true);
	assert.equal(dismissed.ue.server(), null, "Remove needn't wait for the page");
	dismissed.ue.dismiss();
	await until(() => runOf(dismissed) === null);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(dismissed.failures, [], "dismissed: nothing more to show");

	const closed = await failedRun({ page: "manual" });
	await until(() => runOf(closed)?.awaitingPage === true);
	closed.closeWindow();
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(closed.failures, [], "another window, or none: not the server list's problem");
	closed.page.closed = false;
	assert.equal(runOf(closed)?.machines[0]?.status, "failed", "the capsule shows it when this server's page opens again");
	assert.equal(runOf(closed)!.awaitingPage, false, "and main no longer waits on the closed window");
});

test("Retry: Dismiss while main plans stops it, and Pair again is said once, by the server list", async () => {
	const f = await failedRun({ inApp: [true, true] });
	const retrying = f.ue.retry();
	f.ue.dismiss();
	assert.deepEqual(await retrying, { started: false });
	assert.equal(f.asked.length, 1, "no Retry dialog after a Dismiss");

	const unpaired = await failedRun({ inApp: [true, true] });
	unpaired.remote.unpaired = true;
	assert.deepEqual(await unpaired.ue.retry(), { started: false }, "no toast on top of the list's Pair again");
	assert.deepEqual(unpaired.kinds, ["pair"]);
	assert.equal(runOf(unpaired), null);
});

test("a run started from a key says so, also once it failed, so the page main reloads can put focus on the capsule", async () => {
	const f = coveredRun({ page: "manual", countdown: new AbortController(), inApp: [{ update: true, keyboard: true }] });
	assert.deepEqual(await f.ue.everything(), { started: true, keyboard: true, dialog: true });
	assert.equal(runOf(f)!.keyboard, true);
	await until(() => runOf(f)?.awaitingPage === true);
	assert.equal(runOf(f)!.keyboard, true, "the reloaded page sees it too");
	f.ue.later();
	const failed = await failedRun({ inApp: [{ update: true, keyboard: true }] });
	assert.equal(runOf(failed)!.keyboard, true);
	assert.equal(runOf(fixture())?.keyboard, undefined);
	const clicked = coveredRun({ page: "manual", countdown: new AbortController() });
	await clicked.ue.everything();
	assert.equal(runOf(clicked)!.keyboard, false);
});

test("the result toast waits for the page main reloads: the page it replaces can't take it", async () => {
	// Retry: the server back on the target, the page reloaded under the cover's end.
	const f = await failedRun({ inApp: [true, true] });
	f.remote.notice = null;
	f.remote.status = "idle";
	f.remote.pinned = null;
	f.remote.onInstall = () => {
		f.remote.instance = "newer";
		f.remote.tick = () => { f.remote.running = V72; f.remote.health = V72; };
	};
	f.remote.holdLoad = true;
	const old = () => ({ win: f.remote.win, generation: f.page.generation });
	await f.ue.retry();
	await until(() => runOf(f) === null && resultOf(f) !== null);
	const before = old();
	const seen = f.ue.status(before) as { result: number | null };
	assert.equal(seen.result, null, "the old page doesn't see it");
	assert.equal(f.ue.takeResult(before), null, "nor take it");
	f.loadPage();
	await until(() => f.page.generation > before.generation);
	const now = old();
	assert.equal(typeof (f.ue.status(now) as { result: number | null }).result, "number");
	assert.deepEqual(f.ue.takeResult(now), { localVersion: null, updatedServers: 1, failures: [] }, "the page that stays shows it");
	assert.equal(f.ue.takeResult(now), null, "once");

	// A rollback: its failure toast also waits for the reloaded page.
	const rolled = fixture({ expectReconnect: null, page: "manual" });
	rolled.remote.holdLoad = true;
	rolled.remote.onInstall = () => {
		rolled.remote.instance = "back";
		rolled.remote.status = "error";
		rolled.remote.notice = { kind: "rolled-back", version: V72, text: "x", at: 1 };
	};
	await rolled.ue.everything();
	await until(() => runOf(rolled)?.machines[0]?.status === "failed" && resultOf(rolled) !== null);
	const gone = { win: rolled.remote.win, generation: rolled.page.generation };
	assert.equal(rolled.ue.takeResult(gone), null);
	rolled.loadPage();
	await until(() => rolled.page.generation > gone.generation);
	assert.deepEqual(rolled.ue.takeResult({ win: rolled.remote.win, generation: rolled.page.generation })!.failures, [`max-desktop: max-desktop couldn’t start ${V72} and went back to ${V71}. Your app wasn’t changed.`]);
	// Another window (a switch, a reopen) is a page that stays.
	assert.equal(f.ue.takeResult({ win: { id: 9 }, generation: 0 }), null, "nothing left there");
});


// ─── Only the server is behind ───────────────────────────────────────────────

test("with no newer app version, the dialog plans the server alone, at this app's own version", async () => {
	// The app is on V72 with nothing newer to install; its server is still on V71.
	const f = fixture({ appVersion: V72, offered: null, server: V71, inApp: [false] });
	assert.deepEqual(await f.ue.everything(), { started: false, keyboard: false, dialog: true });
	assert.deepEqual(viewOf(f), { version: V72, rows: [{ label: "max-desktop", app: "server", running: 2 }], running: 2, skipped: [], disabledReason: null }, "no This app row: it restarts nothing");
	assert.equal(f.asked[0]!.win, f.remote.win);
	assert.deepEqual(f.log, ["pin"], "Cancel changes nothing: no download, no install");
	assert.equal(f.requests.some((request) => request.path === "/api/updates/install-version"), false);

	// The feed can't be read: the server still catches up with the app, as T3's target is
	// `localUpdateVersion ?? APP_VERSION` and needs no feed.
	const offline = fixture({ appVersion: V72, offered: null, feedDown: true, inApp: [false] });
	await offline.ue.everything();
	assert.deepEqual(viewOf(offline).rows, [{ label: "max-desktop", app: "server", running: 2 }]);
	assert.equal(viewOf(offline).version, V72);

	// An offered app version that is not newer than this app is no update either.
	const stale = fixture({ appVersion: V72, offered: V71, inApp: [false] });
	await stale.ue.everything();
	assert.equal(viewOf(stale).version, V72);
	assert.deepEqual(viewOf(stale).rows.length, 1);
});

test("a newer app version still plans this app too, last", async () => {
	const f = fixture({ appVersion: V71, offered: V72, server: V71, inApp: [false] });
	await f.ue.everything();
	assert.deepEqual(viewOf(f).rows, [{ label: "max-desktop", app: "server", running: 2 }, { label: "This app", app: "this-app", running: 0 }]);
	assert.equal(viewOf(f).version, V72);
});

test("with nothing to move there is no dialog: a server on this app's version or newer, or a build that isn't an exact version", async () => {
	for (const server of [V72, V73]) {
		const f = fixture({ appVersion: V72, offered: null, server, inApp: [true] });
		const answer = await f.ue.everything() as { error: { title: string; detail: string } };
		assert.equal(answer.error.title, "LearnHarness is up to date.", `server ${server}`);
		assert.equal(f.asked.length, 0);
		assert.equal(f.ue.running(), false, "nothing is reserved");
	}
	// A development build has no exact version to ask the server for.
	const dev = fixture({ appVersion: "0.0.0-dev", offered: null, server: V71, inApp: [true] });
	assert.equal((await dev.ue.everything() as { error: { title: string } }).error.title, "LearnHarness is up to date.");
	assert.equal(dev.asked.length, 0);
	assert.equal(dev.requests.some((request) => request.path === "/api/updates/install-version"), false);
});

test("a server that can't update itself isn't planned when only it is behind: Update from its own Settings", async () => {
	const f = fixture({ appVersion: V72, offered: null, server: V71, inApp: [true] });
	f.remote.status = "disabled";
	const answer = await f.ue.everything() as { error: { title: string; detail: string } };
	assert.deepEqual(answer, { error: { title: "Couldn’t update everything.", detail: "Update max-desktop from its own Settings first." } });
	assert.equal(f.asked.length, 0, "nothing to show or press");
});

test("Update moves only the server to exactly this app's version: no download, no countdown, no app restart", async () => {
	const f = fixture({ appVersion: V72, offered: null, server: V71 });
	f.remote.onInstall = () => { f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; };
	assert.deepEqual(await f.ue.everything(), { started: true, keyboard: false, dialog: true });
	assert.equal((f.ue.status() as { phase: string }).phase, "updating", "the run is reserved at once");
	assert.equal(runOf(f)!.localVersion, null, "the capsule shows no app row");
	await until(() => runOf(f) === null && resultOf(f) !== null);
	const asks = f.requests.filter((request) => request.path === "/api/updates/install-version");
	assert.deepEqual(asks.map((request) => request.body), [{ version: V72 }], "exactly the app's version, through install-version");
	assert.deepEqual(f.log.filter((entry) => entry !== "pin" && !entry.startsWith("reconnect")), [], "this app downloads and installs nothing");
	assert.equal(f.prompts.length, 0, "no native dialog, no countdown");
	assert.deepEqual(f.ue.takeResult(), { localVersion: null, updatedServers: 1, failures: [] }, "T3's \"Updated 1 server\"");
	assert.equal(f.results.length, 0, "nothing saved for a relaunch: this app doesn't restart");
});

test("a server-only run that fails stays in the capsule, and Retry asks again for the same version", async () => {
	const f = await failedRun({ appVersion: V72, offered: null, server: V71, inApp: [true, true] });
	assert.equal(runOf(f)!.localVersion, null);
	assert.deepEqual(f.requests.find((request) => request.path === "/api/updates/install-version")!.body, { version: V72 });
	f.remote.notice = null;
	f.remote.status = "idle";
	f.remote.pinned = null;
	f.remote.onInstall = () => { f.remote.running = V72; f.remote.health = V72; f.remote.instance = "new"; };
	assert.deepEqual(await f.ue.retry(), { started: true, keyboard: false, dialog: true });
	assert.deepEqual(viewOf(f, 1).rows, [{ label: "max-desktop", app: "server", running: 2 }]);
	assert.equal(viewOf(f, 1).version, V72);
	await until(() => runOf(f) === null && resultOf(f) !== null);
	assert.equal(f.log.some((entry) => entry.startsWith("install")), false);
	assert.deepEqual(f.requests.filter((request) => request.path === "/api/updates/install-version").map((request) => request.body), [{ version: V72 }, { version: V72 }], "both asks name this app's version");
});

test("a server newer than this app says so in terms of the app, not an update, on a server-only Retry", async () => {
	const f = await failedRun({ appVersion: V72, offered: null, server: V71, inApp: [true] });
	f.remote.running = V73;
	f.remote.notice = null;
	const answer = await f.ue.retry() as { error: { detail: string } };
	assert.equal(answer.error.detail, `max-desktop runs ${V73}, newer than this app (${V72}). Check for updates again.`);
});

test("an app whose updater is off, or on another release track than its server, plans nothing", async () => {
	// A dev build or an unpackaged app: no release of its own to move a server to.
	const dev = fixture({ appVersion: V72, offered: null, server: V71, updaterDisabled: true, inApp: [true] });
	assert.equal((await dev.ue.everything() as { error: { title: string } }).error.title, "LearnHarness is up to date.");
	assert.equal(dev.asked.length, 0);
	assert.equal(dev.requests.some((request) => request.path === "/api/updates/install-version"), false);
	// A plain 0.7.0 sorts after every 0.7.0-nightly.*, and is still no update for a nightly server (T3 compares within a channel).
	const plain = fixture({ appVersion: "0.7.0", offered: null, server: "0.7.0-nightly.20261118.71", inApp: [true] });
	assert.equal((await plain.ue.everything() as { error: { title: string } }).error.title, "LearnHarness is up to date.");
	assert.equal(plain.asked.length, 0);
	const across = fixture({ appVersion: V72, offered: null, server: "0.6.9", inApp: [true] });
	assert.equal((await across.ue.everything() as { error: { title: string } }).error.title, "LearnHarness is up to date.");
});

test("a server on no exact version isn't compared: an app update plans this app alone, never a throw", async () => {
	const f = fixture({ appVersion: V71, offered: V72, server: "dev", inApp: [false] });
	await f.ue.everything();
	assert.deepEqual(viewOf(f).rows, [{ label: "This app", app: "this-app", running: 0 }]);
	assert.equal(viewOf(f).version, V72);
});

test("the run says whether it restarts this app, also while its dialog is open: a server-only one doesn't", async () => {
	const seen: Array<[string, boolean]> = [];
	const only: ReturnType<typeof fixture> = fixture({ appVersion: V72, offered: null, server: V71, inApp: [true], duringAsk: () => seen.push(["dialog", only.ue.restartsApp()]) });
	assert.equal(only.ue.restartsApp(), true, "nothing going: nothing to say");
	// The server is asked while the run is going; asserting there would be swallowed by the run's own catch.
	only.remote.onInstall = () => { seen.push(["run", only.ue.restartsApp()]); only.remote.running = V72; only.remote.health = V72; only.remote.instance = "new"; };
	await only.ue.everything();
	await until(() => runOf(only) === null && resultOf(only) !== null);
	assert.deepEqual(seen, [["dialog", false], ["run", false]], "the dialog's and the run's: this app stays open");
	assert.deepEqual(only.ue.takeResult(), { localVersion: null, updatedServers: 1, failures: [] }, "the run itself succeeded");
	assert.equal(only.ue.restartsApp(), true, "over: nothing to say");

	const both: ReturnType<typeof fixture> = fixture({ inApp: [true], duringAsk: () => seen.push(["both dialog", both.ue.restartsApp()]) });
	both.remote.onInstall = () => { seen.push(["both run", both.ue.restartsApp()]); both.remote.running = V72; both.remote.health = V72; both.remote.instance = "new"; };
	await both.ue.everything();
	await until(() => seen.length === 4);
	assert.deepEqual(seen.slice(2), [["both dialog", true], ["both run", true]], "an app update restarts it");
});

test("the status says this app plans a server-only run only with its updater on and an exact version", () => {
	const flag = (options: Parameters<typeof fixture>[0]) => (fixture(options).ue.status() as { serverOnly: boolean }).serverOnly;
	assert.equal(flag({ appVersion: V72 }), true);
	assert.equal(flag({ appVersion: V72, updaterDisabled: true }), false, "a dev or unpackaged build");
	assert.equal(flag({ appVersion: "0.0.0-dev" }), false, "no exact version to ask a server for");
});

test("preview and nightly are separate tracks: neither is moved to the other's version, in both directions", async () => {
	const PREVIEW = "0.7.0-preview.20261119.5";
	const NIGHTLY = "0.7.0-nightly.20261118.71";
	// A nightly app, nothing newer, against an older-looking preview server, and the reverse.
	for (const [app, server] of [[NIGHTLY, "0.6.9-preview.20261001.1"], [PREVIEW, "0.6.9-nightly.20261001.1"], [PREVIEW, NIGHTLY], [NIGHTLY, "0.7.0-preview.20261101.2"]]) {
		const f = fixture({ appVersion: app, offered: null, server, inApp: [true] });
		assert.equal((await f.ue.everything() as { error: { title: string } }).error.title, "LearnHarness is up to date.", `${app} against ${server}`);
		assert.equal(f.asked.length, 0);
		assert.equal(f.requests.some((request) => request.path === "/api/updates/install-version"), false);
	}
	// Within a track it still moves.
	const same = fixture({ appVersion: PREVIEW, offered: null, server: "0.7.0-preview.20261101.2", inApp: [false] });
	await same.ue.everything();
	assert.deepEqual(viewOf(same).rows, [{ label: "max-desktop", app: "server", running: 2 }]);
	// With an app update of its own, a server on another track is left out: this app alone.
	const updated = fixture({ appVersion: NIGHTLY, offered: "0.7.0-nightly.20261120.80", server: "0.7.0-preview.20261101.2", inApp: [false] });
	await updated.ue.everything();
	assert.deepEqual(viewOf(updated).rows, [{ label: "This app", app: "this-app", running: 0 }]);
});

test("Retry never says updated for a server on no exact version or another track; the older page's install() doesn't count it as behind", async () => {
	for (const running of ["dev", "0.7.0-preview.20261101.2"]) {
		const f = await failedRun({ appVersion: V72, offered: null, server: V71, inApp: [true] });
		f.remote.running = running;
		f.remote.notice = null;
		const answer = await f.ue.retry() as { error?: { detail: string }; started?: boolean };
		assert.equal(answer.started, undefined, `${running}: nothing started`);
		assert.match(answer.error!.detail, new RegExp(`runs ${running.replace(/\./g, "\\.")}, which this app can’t update to`));
		assert.equal(f.ue.takeResult()?.updatedServers ?? 0, 0, `${running}: never reported as updated`);
	}
	// On the target, it is done.
	const back = await failedRun({ appVersion: V72, offered: null, server: V71, inApp: [true] });
	back.remote.running = V72;
	back.remote.notice = null;
	assert.deepEqual(await back.ue.retry(), { started: false });
	// The older page's install(): "dev" is not behind, so the confirmation names this app alone.
	const old = fixture({ appVersion: V71, offered: V72, server: "dev", answers: [1] });
	await old.ue.install();
	assert.equal(old.prompts[0]!.message, `Restart LearnHarness to update to ${V72}?`, "no server update is promised");
});

test("a Cancel starts the cooldown for a server-only ask too", async () => {
	const f = fixture({ appVersion: V72, offered: null, server: V71, inApp: [false, true] });
	await f.ue.everything();
	assert.deepEqual(await f.ue.everything(), { error: { title: "Update everything", detail: "Try again in a moment." } });
	f.advance(ASK_COOLDOWN_MS);
	assert.deepEqual(await f.ue.everything(), { started: true, keyboard: false, dialog: true });
});
