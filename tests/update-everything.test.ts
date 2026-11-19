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
const { createUpdateEverything, serverLabel, HANDOFF_TIMEOUT_MS, RESTART_DELAY_MS, SAVED_RESULT_MAX_AGE_MS } = require("../electron/update-everything.cjs");
const { registerDesktopUpdateIPC } = require("../electron/update-everything-ipc.cjs");

const ORIGIN = "https://max-desktop.tail1234.ts.net:8443";
const V71 = "0.6.1-nightly.20261118.71";
const V72 = "0.6.1-nightly.20261118.72";
const V73 = "0.6.1-nightly.20261118.73";

type Reply = { status?: number; body?: unknown } | Error;
type Prompt = { message: string; detail: string; buttons: string[]; signal?: AbortSignal };

function fixture({ server = V71, offered = V72 as string | null, answers = [0, 0] as Array<number | "wait">, saved = null as unknown, downloadFails = false } = {}) {
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
		pinned: null as unknown, selected: ORIGIN,
		// POSTs that get no answer: the transport gives up after its 15 s timeout (requestServer's),
		// and `startsAnyway` says whether the server got it before the answer was lost.
		postTimeouts: 0, startsAnyway: true,
	};
	let finished: () => void = () => {};
	const done = new Promise<void>((resolve) => { finished = resolve; });
	const ue = createUpdateEverything({
		appVersion: V71,
		updater: {
			state: () => ({ status: offered ? "available" : "up-to-date", version: offered }),
			check: () => log.push("check"),
			download: () => log.push("download"),
			pin: async () => { log.push("pin"); return offered; },
			downloadPinned: async (v: string) => { if (downloadFails) throw new Error("sha512 checksum mismatch"); log.push(`download ${v}`); },
			// The app-only retry: exactly v, whatever the feed's newest is.
			downloadExact: async (v: string) => { log.push(`exact ${v}`); },
			installPinned: (v: string) => {
				if (remote.installFails > 0) { remote.installFails--; log.push(`install ${v} failed`); throw new Error("Could not locate update bundle"); }
				log.push(`install ${v}`); finished();
			},
		},
		selection: () => ({ origin: remote.selected, token: "bearer" }),
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
		reconnect: (origin: string, version: string) => { assert.equal(version, V72, "Later shows the version the server is now on"); log.push(`reconnect ${origin}`); finished(); },
		saveResult: (record: unknown) => { results.push(record); stored = record; },
		takeResult: () => { const value = stored; stored = null; return value; },
		now: () => clock,
		timeoutSignal: (ms: number) => { assert.equal(ms, RESTART_DELAY_MS); return AbortSignal.timeout(5); },
		sleep: async (ms: number) => { clock += ms; remote.tick?.(); await new Promise((resolve) => setImmediate(resolve)); },
	});
	return { ue, log, prompts, notices, failures, kinds, progress, requests, results, remote, done, advance: (ms: number) => { clock += ms; } };
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

test("status reports the run, and a second click while the dialog is open is ignored", async () => {
	const f = fixture({ answers: [0, 1] });
	assert.deepEqual(f.ue.status(), { version: V71, target: V72, phase: "available", error: null, downloadPercent: null });
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

test("the bridge answers only the remote window's main frame at its origin, with no arguments", async () => {
	const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
	const mainFrame = { url: `${ORIGIN}/learn/x` };
	const contents = { mainFrame };
	const win = { webContents: contents, isDestroyed: () => false };
	const calls: string[] = [];
	registerDesktopUpdateIPC({ handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) }, {
		current: () => ({ win, origin: ORIGIN }),
		updateEverything: { status: () => { calls.push("status"); return { phase: "idle" }; }, check: () => calls.push("check"), download: () => calls.push("download"), install: async () => { calls.push("install"); } },
	});
	const handle = handlers.get("lh:desktop-update")!;
	assert.deepEqual(await handle({ sender: contents, senderFrame: mainFrame }, "status"), { phase: "idle" });
	await handle({ sender: contents, senderFrame: mainFrame }, "install");
	assert.deepEqual(calls, ["status", "install"]);
	const refused = [
		[{ sender: {}, senderFrame: mainFrame }, "status"],
		[{ sender: contents, senderFrame: { url: `${ORIGIN}/x` } }, "status"],
		[{ sender: contents, senderFrame: { ...mainFrame } }, "install"],
		[{ sender: contents, senderFrame: mainFrame, }, "install", V72],
		[{ sender: contents, senderFrame: mainFrame }, "quitAndInstall"],
	] as const;
	for (const [event, ...args] of refused) await assert.rejects(handle(event, ...args), /Untrusted desktop request/);
	mainFrame.url = "https://evil.example/";
	await assert.rejects(handle({ sender: contents, senderFrame: mainFrame }, "status"), /Untrusted/);
	assert.deepEqual(calls, ["status", "install"]);
});

test("the remote preload exposes only window.lh.desktopUpdate with four methods", () => {
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
	assert.deepEqual(Object.keys(lh), ["desktopUpdate"]);
	assert.deepEqual(Object.keys(lh.desktopUpdate), ["getStatus", "check", "download", "install"]);
	lh.desktopUpdate.install!("0.0.1-evil", "https://evil.example");
	assert.deepEqual(invoked, [["lh:desktop-update", "install"]], "arguments from the page are never forwarded");
});
