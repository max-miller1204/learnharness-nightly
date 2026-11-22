"use strict";

/*
 * Update everything (roadmap item 23 PR 2, docs/specs/desktop-server-list.md):
 * from the desktop app's window onto a self-hosted server, bring that server
 * to the exact release this app installs, wait until its launcher has kept
 * it, then install and restart this app. Main owns every step. The remote
 * page only reaches the zero-argument methods in remote-preload.cjs: it can
 * ask main to show its Update everything dialog, never start a run itself.
 *
 * Follows T3 Code at 8cf97b5 where it applies (useUpdateEverything.ts and
 * updateEverythingRun.tsx): one pinned target, servers before this app, a
 * 32-minute "Not back" limit (updateEverythingRun.tsx:191), a 5 s restart
 * countdown that Later postpones (useUpdateEverything.ts:37, :248-249), and a
 * saved result read once on the next launch (updateEverythingRun.tsx:188-189,
 * :251-265). Unlike T3, this app restarts only after the launcher COMMITS the
 * server's new version, not when its restart starts (owner decision).
 */

const { compareVersions, bridgeNotes } = require("./release-notes.cjs");
const { hasDownloadableOffer, hasInstallableDownload } = require("./update-machine.cjs");

const EXACT = /^\d+\.\d+\.\d+(?:-[a-z]+\.\d{8}\.\d+)?$/;
const isNewerVersion = (a, b) => typeof a === "string" && typeof b === "string" && EXACT.test(a) && EXACT.test(b) && compareVersions(a, b) > 0;

const HANDOFF_TIMEOUT_MS = 32 * 60 * 1000;
const RESTART_DELAY_MS = 5_000;
const POLL_MS = 2_000;
// Polls in a row where the route answers 5xx but the server shows no attempt: then it's the route, not a restart.
const ROUTE_ERROR_LIMIT = 3;
const SAVED_RESULT_MAX_AGE_MS = 10 * 60 * 1000;
const INSTALL_VERSION_PATH = "/api/updates/install-version";
// How long main waits for the server's page to show the capsule (revision PR 7) before it shows
// its own native countdown or failure instead: a page from before PR 7 never does.
const PAGE_READY_TIMEOUT_MS = 10_000;
// After a Cancel, the page can't ask for the dialog again for this long.
const ASK_COOLDOWN_MS = 3_000;
const TOO_SOON = { title: "Update everything", detail: "Try again in a moment." };
// What the page's toast says when main can't ask now, so no click is silent.
const BUSY = { title: "Update everything", detail: "Update everything is already running." };
const NO_SERVER = { title: "Update everything", detail: "Open a paired server to update it." };
const NOTHING_TO_RETRY = { title: "Update everything", detail: "There is nothing to retry." };

// The ghost dashboard's name for a server: its first label, or a whole IP.
const { hostLabel: serverLabel } = require("./skeleton.cjs");

function plural(count, one, other) {
	return `${count} ${count === 1 ? one : other}`;
}

/** The native confirmation's text (plan approved 2026-11-18). */
function confirmation({ label, target, serverBehind, running }) {
	// Cancel is the default and the cancel button: Enter or Escape changes nothing.
	if (!serverBehind) {
		return {
			message: `Restart LearnHarness to update to ${target}?`,
			detail: `${label} already runs ${target}. Only this app restarts.`,
			buttons: ["Restart", "Cancel"], defaultId: 1, cancelId: 1,
		};
	}
	const stops = running > 0 ? ` ${plural(running, "running task", "running tasks")} there will stop.` : "";
	return {
		message: "Update everything?",
		detail: `Update ${label} and this app to ${target}.\n\n1. ${label} updates first and restarts. This takes a few minutes.${stops}\n2. Once ${label} is back, this app restarts to finish.`,
		buttons: ["Update everything", "Cancel"], defaultId: 1, cancelId: 1,
	};
}

/** Settings' This app Install: T3's install confirm (getDesktopUpdateInstallConfirmationMessage,
 *  apps/web/src/components/desktopUpdate.logic.ts:180-197 at df09ced7), worded as
 *  components/install-update-dialog.tsx words it, in a native dialog. */
function installAppConfirmation(version) {
	return {
		message: `Install update${version ? ` ${version}` : ""} and restart LearnHarness?`,
		detail: "Any running tasks will be interrupted. Make sure you're ready before continuing.",
		buttons: ["Install and restart", "Cancel"], defaultId: 1, cancelId: 1,
	};
}

class RunProblem extends Error {
	/** `server` failures leave the app as it is and offer Retry (or Pair again) and Switch server….
	 *  `unreachable`: the server's page can't be shown either (it never came back), so the list
	 *  shows the problem, never the page's capsule. `version`: what the server runs after it. */
	constructor(message, { server = false, kind = "retry", unreachable = false, version = null } = {}) {
		super(message);
		this.server = server;
		this.kind = kind;
		this.unreachable = unreachable;
		this.version = version;
	}
}

async function readJSON(response) {
	try { return await response.json(); } catch { return null; }
}

/**
 * deps:
 *   appVersion                 this app's running version
 *   updater.state()            { status, version } from main's updater snapshot
 *   updater.check()            a manual check (the Settings/menu one)
 *   updater.download()         download the offered version
 *   updater.pin()              re-check the feed; resolves the newest offered version or null
 *   updater.downloadPinned(v)  make sure exactly v is downloaded (throws otherwise)
 *   updater.downloadExact(v)   the app-only retry: check for exactly v (not the newest), download it
 *   updater.installPinned(v)   quit and install exactly v (never a newer one)
 *   updater.install()          the plain Install: re-check, then quit and install this app
 *   selection()                { origin, token } of the open remote window, or null
 *   request(origin, path, { token, method, body, timeoutMs }) a fetch to that exact origin
 *   confirm({ message, detail, buttons, signal }) -> button index (native dialog)
 *   tell({ message, detail })  a native notice with one OK button
 *   progress(origin, text)     cover that server's page with the ghost dashboard line
 *   fail(origin, { kind, message }) show the server window with Retry (or Pair again)
 *   reconnect(origin, version) uncover the server's page and show `version` in the same window, loaded once (after Later);
 *                              may resolve true when that reloaded the page
 *   page(win)                  that window's page loads, or null: { generation() (its main-frame
 *                              documents so far, the one ready() came from is counted), settled() (its
 *                              loads that finished or failed), closed(), watch(onChange) -> unwatch }
 *   saveResult(record) / takeResult()  userData file for the next launch
 *   askInApp(selection, plan) -> { update, keyboard }: whether the user pressed Update in main's
 *                              own Update everything dialog over that window, and whether a key
 *                              closed it (electron/update-everything-dialog.cjs), a surface the
 *                              server's page can't script (revision PR 7)
 *   now(), sleep(ms), timeoutSignal(ms) (defaults to AbortSignal.timeout)
 */
function createUpdateEverything(deps) {
	let run = null; // { target, step: "downloading" | "updating" | "restarting" }, plus the page's view of an in-page run
	// A confirmation (native or main's own dialog) is open, or a run is being reserved: nothing else starts.
	let asking = false;
	// The server a run, its confirmation or its plan talks to with its bearer (Remove waits for it).
	// Each hold is released only by whoever took it, never by another run's cleanup.
	let holding = null;
	const hold = (origin) => {
		const mine = { origin };
		holding = mine;
		return () => { if (holding === mine) holding = null; };
	};
	// Revision PR 7: the run kept after a server failure for the capsule's Retry and Dismiss, the
	// result toast (read once, numbered so a second one isn't mistaken for the first), the
	// countdown's Later, and the page's "the capsule shows this" signal.
	let kept = null;
	let result = null;
	let results = 0;
	let decideRestart = null;
	// What main waits on the page for, each on its own (pageShows).
	const waits = new Set();
	// When the user last said no (main's dialog, or the native confirmation): no repeat ask until ASK_COOLDOWN_MS.
	let declinedAt = -Infinity;
	const clock = () => (deps.now ? deps.now() : Date.now());
	const tooSoon = () => clock() - declinedAt < ASK_COOLDOWN_MS;

	/** What the page's capsule shows of an in-page run, or of a run kept after its failure.
	 *  Labels and messages are main's own text, never the page's. */
	function runView(source) {
		if (!source) return null;
		return {
			phase: source.phase,
			localVersion: source.localVersion,
			restartAt: source.restartAt,
			machines: source.machines.map(({ label, status, startedAt, failure }) => ({ label, status, startedAt, failure })),
			// Main waits for the page to say it shows this (ready()).
			awaitingPage: source.awaitingPage === true,
			// A key closed main's dialog with Update: the page that shows this puts focus on the
			// capsule, also the one main reloads after the server's cover.
			keyboard: source.keyboard === true,
		};
	}

	/** Show the server's page again after its cover, and which of its page loads can say it shows
	 *  the capsule: the reload's, when this reloaded it. */
	async function reconnect(selection, version) {
		const page = deps.page?.(selection.win) ?? null;
		const before = page && { generation: page.generation(), settled: page.settled() };
		const reloaded = (await deps.reconnect(selection.origin, version)) === true;
		return before && reloaded ? { generation: before.generation + 1, settled: before.settled + 1 } : null;
	}

	/** Until the page in `selection`'s window says the capsule shows `source` (ready()), or
	 *  PAGE_READY_TIMEOUT_MS from when that page has loaded. After a reload (`after`, from
	 *  reconnect()) only the new page can say so, never the one it replaced. Dismiss, and the
	 *  window closing (also a switch to another server), end the wait as not shown. */
	function pageShows(source, selection, after = null) {
		const page = deps.page?.(selection.win) ?? null;
		const wait = { source, win: selection.win, generation: after?.generation ?? page?.generation() ?? 0, settle: null };
		source.awaitingPage = true;
		return new Promise((resolve) => {
			let signal = null;
			let unwatch = () => {};
			const late = () => wait.settle(false);
			wait.settle = (shown) => {
				if (!waits.delete(wait)) return;
				if (![...waits].some((other) => other.source === source)) source.awaitingPage = false;
				signal?.removeEventListener("abort", late);
				unwatch();
				resolve(shown);
			};
			waits.add(wait);
			const check = () => {
				if (page?.closed()) return wait.settle(false);
				if (signal || (after && page && page.settled() < after.settled)) return;
				signal = (deps.timeoutSignal ?? AbortSignal.timeout)(PAGE_READY_TIMEOUT_MS);
				if (signal.aborted) return wait.settle(false);
				signal.addEventListener("abort", late, { once: true });
			};
			if (page) unwatch = page.watch(check);
			check();
		});
	}

	/** The same window, still on the same server. */
	const stillOn = (selection) => {
		const now = deps.selection();
		return !!now && now.win === selection.win && now.origin === selection.origin;
	};

	/** The waiting result, unless `from` (the asking page, { win, generation }) is a page from
	 *  before the reload that will replace it: that page goes, and its toast with it, so the
	 *  result waits for the page that stays. */
	function resultFor(from) {
		if (!result) return null;
		const page = result.page;
		if (page && from && from.win === page.win && !(from.generation >= page.generation)) return null;
		return result;
	}

	function status(from) {
		const state = deps.updater.state();
		// The sidebar's progress ring: how far this app's own download is, or null (not downloading, or no size).
		const downloadPercent = state.status === "downloading" && typeof state.downloadPercent === "number" ? state.downloadPercent : null;
		// A run shows no notes, also in its download step, which the page can't tell from a
		// plain download (T3's `!isRunningEverything`, SidebarUpdatePill.tsx:279-280).
		// A run kept after its failure shows only on its own server's page, where Retry acts.
		const shownKept = kept && deps.selection()?.origin === kept.origin ? kept : null;
		const page = { run: runView(run?.inPage ? run : shownKept), result: resultFor(from)?.id ?? null };
		if (run) return { version: deps.appVersion, target: run.target, phase: run.step === "downloading" ? "downloading" : "updating", error: null, downloadPercent, releaseNotes: [], omittedReleaseCount: 0, ...page };
		// The offered version's notes (the reducers keep them until a new check or "no update"
		// clears them, electron/update-machine.cjs), bounded: the sidebar's hover shows them for this
		// app's states, as T3's does.
		const notes = bridgeNotes(state.releaseNotes, state.omittedReleaseCount);
		return {
			version: deps.appVersion,
			target: typeof state.version === "string" ? state.version : null,
			phase: state.status,
			error: state.status === "error" ? "Couldn’t check for updates. Try again later." : null,
			downloadPercent,
			...notes,
			...page,
		};
	}

	/** While `restarting`, an unreadable answer (the HTTPS proxy's 502 while the
	 *  server is down) means "not back yet": null instead of a failure. */
	async function serverUpdates(origin, token, { restarting = false } = {}) {
		const response = await deps.request(origin, "/api/updates", { token });
		if (response.status === 401) throw new RunProblem("This desktop is no longer paired with the server.", { server: true, kind: "pair" });
		const body = response.ok ? await readJSON(response) : null;
		if (body && typeof body.runningVersion === "string") return body;
		if (restarting) return null;
		throw new RunProblem("Couldn’t read the server’s version. Try again.", { server: true });
	}

	async function runningCount(origin, token) {
		try {
			const response = await deps.request(origin, "/api/updates/running", { token });
			const body = response.ok ? await readJSON(response) : null;
			return Array.isArray(body?.items) ? body.items.length : 0;
		} catch { return 0; }
	}

	/** Ask the server for exactly `target`, then wait for its launcher to keep it.
	 *  `before` is the server process seen before the run. The server answers the
	 *  request at once and stages in the background (`pinned` in GET /api/updates).
	 *  A request that gets no answer may still have started, so it is sent again on
	 *  each poll (the same request is harmless) and the run never claims nothing
	 *  changed unless the server itself refused. */
	async function updateServer(selection, label, target, before, machine = null, beforeVersion = null) {
		const { origin, token } = selection;
		run.step = "updating";
		const coverText = `Updating ${label} to ${target}… This can take a few minutes.`;
		// An older page has no capsule: the cover shows the whole server step, as before. The
		// page's run (`machine`) keeps the page in view and covers it only while the server
		// restarts and can't render it (revision PR 7).
		if (!machine) deps.progress(origin, coverText);
		let asked = false;
		// Only once the server has been asked: before that, nothing is restarting.
		// `restarted`: the server is another process already, so it got the request even when its answer was lost.
		const restarting = (restarted = false) => {
			if (!machine || !(asked || restarted) || machine.status === "restarting") return;
			machine.status = "restarting";
			if (!machine.covered) { machine.covered = true; deps.progress(origin, coverText); }
		};
		// The id of the server's attempt this run's request started (or joined):
		// only its `pinned.error` is this run's failure, never one left from earlier.
		let attempt = null;
		// A 5xx from the route itself, while the server answers GET /api/updates as
		// the same process with no attempt for the target, is the route failing.
		let routeError = null;
		let routeErrors = 0;
		const ask = async () => {
			let response;
			try {
				response = await deps.request(origin, INSTALL_VERSION_PATH, { token, method: "POST", body: { version: target } });
			} catch {
				return; // No answer: maybe started. Poll, and ask again.
			}
			if (response.status >= 500) { routeError = response.status; return; } // Maybe the proxy while the server restarts.
			routeError = null;
			const body = await readJSON(response);
			if (response.status === 404) throw new RunProblem(`${label} runs a LearnHarness without Update everything. Update it from its own Settings first.`, { server: true, version: beforeVersion });
			if (response.status === 401) throw new RunProblem("This desktop is no longer paired with the server.", { server: true, kind: "pair" });
			if (!response.ok) throw new RunProblem(`${label} can’t update: ${typeof body?.error === "string" ? body.error : `HTTP ${response.status}`} Nothing was changed.`, { server: true, version: beforeVersion });
			asked = true;
			if (machine?.status === "waiting") machine.status = "downloading";
			const pinned = body?.pinned;
			if (pinned?.version === target && pinned.error === null && typeof pinned.id === "string") attempt = pinned.id;
		};
		const deadline = deps.now() + HANDOFF_TIMEOUT_MS;
		while (deps.now() < deadline) {
			if (!asked) await ask();
			try {
				const health = await deps.request(origin, "/api/health", {});
				const healthy = health.ok && (await readJSON(health))?.version === target;
				const state = await serverUpdates(origin, token, { restarting: true });
				if (!state) { restarting(); throw new Error("not back yet"); }
				if (healthy && state.runningVersion === target && state.committed === true) return;
				// A new process that hasn't been kept yet: the launcher is still trying the new version.
				if (state.instance !== before) restarting(typeof before === "string");
				if (attempt && state.pinned?.id === attempt && typeof state.pinned.error === "string") {
					throw new RunProblem(`${label} couldn’t start the update: ${state.pinned.error} Your app wasn’t changed.`, { server: true, version: state.runningVersion });
				}
				const started = state.pinned?.version === target && !state.pinned.error;
				if (routeError && state.instance === before && !started) {
					routeErrors += 1;
					if (routeErrors >= ROUTE_ERROR_LIMIT) throw new RunProblem(`${label} can’t update: HTTP ${routeError}. Nothing was changed.`, { server: true, version: state.runningVersion });
				} else {
					routeErrors = 0;
				}
				if (state.instance !== before && state.runningVersion !== target && state.notice?.kind === "rolled-back" && state.notice.version === target) {
					throw new RunProblem(`${label} couldn’t start ${target} and went back to ${state.runningVersion}. Your app wasn’t changed.`, { server: true, version: state.runningVersion });
				}
			} catch (error) {
				if (error instanceof RunProblem) throw error;
				// Restarting: keep waiting. Once asked, a server that doesn't answer is restarting.
				if (asked) restarting();
			}
			await deps.sleep(POLL_MS);
		}
		throw new RunProblem(asked
			? `${label} wasn’t back after ${HANDOFF_TIMEOUT_MS / 60_000} minutes. Your app wasn’t changed.`
			: `Couldn’t reach ${label} for ${HANDOFF_TIMEOUT_MS / 60_000} minutes. Your app wasn’t changed.`, { server: true, unreachable: true });
	}

	/** A saved result whose install never started: read it away, so the next launch offers nothing. */
	function forgetResult() {
		try { deps.takeResult(); } catch { /* nothing saved */ }
	}

	/** PR 2 item 4: the server committed `target` but this app didn't install it.
	 *  Offer an explicit app-only retry of exactly that version, even when the
	 *  feed has moved on (a newer version means a new Update everything). */
	async function offerRetry(retry) {
		if (run || asking || !retry || typeof retry.target !== "string") return;
		asking = true;
		let choice;
		try {
			choice = await deps.confirm({
				type: "warning",
				message: "The app update didn’t finish.",
				detail: `LearnHarness is still on ${deps.appVersion} and ${serverLabel(retry.updated ?? retry.server)} is on ${retry.target}. Install LearnHarness ${retry.target} again? Only this app restarts.`,
				buttons: ["Try Again", "Later"], defaultId: 1, cancelId: 1,
			});
		} finally { asking = false; }
		if (choice !== 0) return;
		run = { target: retry.target, step: "downloading" };
		try {
			await deps.updater.downloadExact(retry.target);
			run.step = "restarting";
			// `retried`: if this install fails too (seen only after the relaunch, on every platform),
			// the next launch says so instead of offering Try Again again.
			deps.saveResult({ savedAt: deps.now(), server: deps.selection()?.origin ?? retry.server, updated: retry.updated ?? retry.server, from: deps.appVersion, target: retry.target, retried: true });
			// An installer error main recovers from (installFailed): the same failure text, once.
			run.installFailed = async () => {
				run = null;
				forgetResult();
				await retryFailed(retry);
			};
			deps.updater.installPinned(retry.target);
		} catch {
			run = null;
			forgetResult(); // offered once: a relaunch doesn't offer it again
			await retryFailed(retry);
		}
	}

	/** Owner wording, 2026-11-19: point to Update everything (the menu installs the newest app version, not X). */
	function retryFailed(retry) {
		return deps.tell({ message: "Couldn’t install the app update.", detail: `LearnHarness is still on ${deps.appVersion} and ${serverLabel(retry.updated ?? retry.server)} is on ${retry.target}. Use Update everything to try again.` });
	}

	/** `answered` resolves the page's install() once the confirmation is decided (or skipped). */
	async function start(answered) {
		const selection = deps.selection();
		if (!selection) return;
		const release = hold(selection.origin);
		try { await startWith(selection, answered); } finally { release(); }
	}
	async function startWith(selection, answered) {
		const label = serverLabel(selection.origin);
		let target;
		try {
			target = await deps.updater.pin();
		} catch {
			target = null;
		}
		if (!target || !isNewerVersion(target, deps.appVersion)) {
			await deps.tell({ message: "LearnHarness is up to date.", detail: "No newer version of this app was found." });
			return;
		}
		let server;
		try {
			server = await serverUpdates(selection.origin, selection.token);
		} catch (error) {
			await deps.tell({ message: "Couldn’t update everything.", detail: error.message });
			return;
		}
		if (isNewerVersion(server.runningVersion, target)) {
			await deps.tell({ message: "Couldn’t update everything.", detail: `${label} runs ${server.runningVersion}, newer than this app’s update (${target}). Check for updates again.` });
			return;
		}
		const serverBehind = compareVersions(server.runningVersion, target) < 0;
		const running = serverBehind ? await runningCount(selection.origin, selection.token) : 0;
		const text = confirmation({ label, target, serverBehind, running });
		const choice = await deps.confirm(text);
		answered();
		if (choice !== 0) {
			declinedAt = clock();
			return;
		}

		run = { target, step: "downloading" };
		let serverDone = false;
		try {
			try {
				await deps.updater.downloadPinned(target);
			} catch {
				throw new RunProblem("Couldn’t download the app update. Nothing was changed.");
			}
			if (serverBehind) {
				await updateServer(selection, label, target, typeof server.instance === "string" ? server.instance : null);
				serverDone = true;
			}
			run.step = "restarting";
			const countdown = (deps.timeoutSignal ?? AbortSignal.timeout)(RESTART_DELAY_MS);
			const later = await deps.confirm({
				message: serverBehind ? `${label} is on ${target}.` : `LearnHarness ${target} is ready.`,
				detail: `LearnHarness restarts in ${RESTART_DELAY_MS / 1000} seconds to finish updating.`,
				buttons: ["Restart now", "Later"],
				signal: countdown,
			});
			if (later === 1 && !countdown.aborted) {
				run = null;
				if (serverBehind) deps.reconnect(selection.origin, target);
				return;
			}
			// Reopen the server that is open now (the user may have switched); `updated` is the one the run moved.
			deps.saveResult({ savedAt: deps.now(), server: deps.selection()?.origin ?? selection.origin, updated: selection.origin, from: deps.appVersion, target });
			// An installer error main recovers from (installFailed) ends the run as a failed app install
			// would: with the server on the target, its page and the app-only retry; else a notice.
			run.installFailed = async () => {
				run = null;
				forgetResult();
				if (serverDone) {
					deps.reconnect(selection.origin, target);
					await offerRetry({ target, server: selection.origin, updated: selection.origin });
				} else {
					await deps.tell({ message: "Couldn’t update everything.", detail: "Couldn’t install the app update. Try again." });
				}
			};
			deps.updater.installPinned(target);
		} catch (error) {
			const saved = run?.step === "restarting";
			run = null;
			if (saved) forgetResult(); // installPinned threw after saveResult: this session offers the retry itself
			if (serverDone) {
				// The server is already on the target: uncover its new page and offer the app-only retry.
				deps.reconnect(selection.origin, target);
				await offerRetry({ target, server: selection.origin, updated: selection.origin });
				return;
			}
			const problem = error instanceof RunProblem ? error : new RunProblem("Update everything stopped. Nothing was changed.");
			if (problem.server) deps.fail(selection.origin, { kind: problem.kind, message: problem.message });
			else await deps.tell({ message: "Couldn’t update everything.", detail: problem.message });
		}
	}

	/** What main's Update everything dialog shows (revision PR 7; T3's UpdateEverythingDialog.tsx at
	 *  df09ced7): the rows of what this run would update. Main pins the version and reads the server
	 *  itself; nothing comes from the page. `target` and `serverOnly`: a Retry of that server, with the
	 *  same version, and this app left out (T3's retryFailedUpdateRunServers). Returns { plan },
	 *  { done } (Retry: the server is already on the target) or { error } (what to tell).
	 *
	 *  Revision PR 8: with no newer app version, the target is this app's own version and the plan
	 *  moves only the server, which this app never restarts for. T3 does the same: its target is
	 *  `localUpdateVersion ?? APP_VERSION` and it offers the run while a server is behind it
	 *  (useUpdateEverything.ts:55-56, :104 at df09ced7), installing locally only when the app has an
	 *  update (SidebarUpdatePill.tsx:373-386). */
	async function makePlan(selection, { target: pinned = null, serverOnly: retry = false } = {}) {
		const label = serverLabel(selection.origin);
		let target = pinned;
		let serverOnly = retry;
		// The app has nothing newer: the server catches up with the app, as in T3.
		let appCurrent = false;
		if (!target) {
			try { target = await deps.updater.pin(); } catch { target = null; }
			if (!target || !isNewerVersion(target, deps.appVersion)) {
				target = deps.appVersion;
				serverOnly = true;
				appCurrent = true;
			}
		}
		const upToDate = { error: { title: "LearnHarness is up to date.", detail: "No newer version of this app was found." } };
		if (appCurrent && !EXACT.test(target)) return upToDate;
		let server;
		try { server = await serverUpdates(selection.origin, selection.token); } catch (error) {
			return { error: { title: "Couldn’t update everything.", detail: error.message, kind: error instanceof RunProblem ? error.kind : "retry" } };
		}
		// Nothing to move: the server already runs this app's version, or a newer one.
		if (appCurrent && !isNewerVersion(target, server.runningVersion)) return upToDate;
		if (isNewerVersion(server.runningVersion, target)) {
			return { error: { title: "Couldn’t update everything.", detail: `${label} runs ${server.runningVersion}, newer than this app’s update (${target}). Check for updates again.` } };
		}
		const serverBehind = compareVersions(server.runningVersion, target) < 0;
		if (retry && !serverBehind) return { done: true };
		// A server that can't update itself is skipped, and this app waits for it: an app newer
		// than its server could stop speaking its protocol.
		const manual = serverBehind && server.status === "disabled";
		const reason = manual ? (typeof server.message === "string" && server.message.trim() ? server.message.trim().slice(0, 200) : "needs a manual update") : null;
		const disabledReason = manual ? `Update ${label} from its own Settings first.` : null;
		if (serverOnly && manual) return { error: { title: "Couldn’t update everything.", detail: disabledReason } };
		const running = serverBehind && !manual ? await runningCount(selection.origin, selection.token) : 0;
		const rows = [
			...(serverBehind && !manual ? [{ label, app: "server", running }] : []),
			// This app last (owner, docs/specs/desktop-server-list.md): it restarts after the server.
			...(serverOnly ? [] : [{ label: "This app", app: "this-app", running: 0 }]),
		];
		return {
			plan: {
				target, label, serverBehind: serverBehind && !manual, serverOnly,
				before: typeof server.instance === "string" ? server.instance : null, beforeVersion: server.runningVersion,
				view: { version: target, rows, running, skipped: manual ? [{ label, reason }] : [], disabledReason },
			},
		};
	}

	/** Main's own dialog, over `selection`'s window, then the same window still open on the same
	 *  server and pairing: a window closed and opened again since is another one. */
	async function confirmedInApp(selection, plan) {
		const answer = await deps.askInApp(selection, plan.view);
		const keyboard = answer?.keyboard === true;
		if (plan.view.disabledReason || !(answer === true || answer?.update === true)) {
			declinedAt = clock();
			return { confirmed: false, keyboard };
		}
		const now = deps.selection();
		return { confirmed: !!now && now.win === selection.win && now.origin === selection.origin && now.token === selection.token, keyboard };
	}

	/** The countdown before this app restarts: resolves true when it runs out, false on Later. It
	 *  starts once the page shows it (ready()), so the 5 s are the user's; a page that never says so
	 *  (one from before PR 7) gets main's native countdown instead. */
	async function countdown(selection, label, target, serverBehind, after) {
		run.phase = "countdown";
		run.restartAt = null;
		if (!(await pageShows(run, selection, after))) {
			const signal = (deps.timeoutSignal ?? AbortSignal.timeout)(RESTART_DELAY_MS);
			const later = await deps.confirm({
				message: serverBehind ? `${label} is on ${target}.` : `LearnHarness ${target} is ready.`,
				detail: `LearnHarness restarts in ${RESTART_DELAY_MS / 1000} seconds to finish updating.`,
				buttons: ["Restart now", "Later"],
				signal,
			});
			return !(later === 1 && !signal.aborted);
		}
		run.restartAt = deps.now() + RESTART_DELAY_MS;
		const signal = (deps.timeoutSignal ?? AbortSignal.timeout)(RESTART_DELAY_MS);
		return new Promise((resolve) => {
			const decide = (restart) => {
				decideRestart = null;
				signal.removeEventListener("abort", ran);
				resolve(restart);
			};
			const ran = () => decide(true);
			if (signal.aborted) return decide(true);
			signal.addEventListener("abort", ran, { once: true });
			decideRestart = decide;
		});
	}

	/** `after` (from reconnect()): only the page from that reload takes it. */
	const newResult = (fields, selection = null, after = null) => ({
		id: ++results, localVersion: null, updatedServers: 0, failures: [], ...fields,
		page: selection && after ? { win: selection.win, generation: after.generation } : null,
	});

	/** An in-page run: the same steps as the native one (download, the server to exactly the
	 *  target, its commit, then this app), shown in the page's capsule. `serverOnly` (Retry): only
	 *  the server, as T3 retries a failed server; this app stays as it is. Everything up to the
	 *  first await runs at once, so the run is reserved before the caller lets go. */
	async function runInPage(selection, chosen, { serverOnly = false, keyboard = false } = {}) {
		const { target, label, serverBehind } = chosen;
		const machine = serverBehind ? { label, status: "waiting", startedAt: deps.now(), failure: null, covered: false } : null;
		run = { target, step: serverOnly ? "updating" : "downloading", inPage: true, keyboard, phase: "servers", localVersion: serverOnly ? null : target, restartAt: null, machines: machine ? [machine] : [] };
		const release = hold(selection.origin);
		let serverDone = false;
		// The page load that shows the capsule again after the server's cover, when it reloaded.
		let after = null;
		try {
			if (!serverOnly) {
				try {
					await deps.updater.downloadPinned(target);
				} catch {
					throw new RunProblem("Couldn’t download the app update. Nothing was changed.");
				}
			}
			if (machine) {
				machine.startedAt = deps.now();
				await updateServer(selection, label, target, chosen.before, machine, chosen.beforeVersion);
				machine.status = "done";
				serverDone = true;
				// Back on the target: the page shows again (the capsule, then the countdown).
				if (machine.covered) after = await reconnect(selection, target);
			}
			if (serverOnly) {
				run = null;
				result = newResult({ updatedServers: 1 }, selection, after);
				return;
			}
			if (!(await countdown(selection, label, target, serverDone, after))) {
				run = null;
				// Later: the server is updated and this app stays as it is until its own Install.
				if (serverDone) result = newResult({ updatedServers: 1 }, selection, after);
				return;
			}
			run.phase = "installing";
			run.restartAt = null;
			run.step = "restarting";
			deps.saveResult({ savedAt: deps.now(), server: deps.selection()?.origin ?? selection.origin, updated: selection.origin, from: deps.appVersion, target, inPage: true, updatedServers: serverDone ? 1 : 0 });
			run.installFailed = async () => {
				run = null;
				forgetResult();
				if (serverDone) await offerRetry({ target, server: selection.origin, updated: selection.origin });
				else result = newResult({ failures: ["This app: Couldn’t install the app update. Try again."] });
			};
			deps.updater.installPinned(target);
		} catch (error) {
			const saved = run?.step === "restarting";
			run = null;
			if (saved) forgetResult();
			if (serverDone) {
				await offerRetry({ target, server: selection.origin, updated: selection.origin });
				return;
			}
			const problem = error instanceof RunProblem ? error : new RunProblem("Update everything stopped. Nothing was changed.");
			if (machine && problem.server && problem.kind === "retry" && !problem.unreachable) {
				// The server's page can show this: the capsule says "<server> failed" with Retry.
				machine.status = "failed";
				machine.failure = problem.message;
				const failedRun = { origin: selection.origin, target, label, keyboard, phase: "servers", localVersion: null, restartAt: null, machines: [machine] };
				kept = failedRun;
				const failures = [`${label}: ${problem.message}`];
				if (!machine.covered) result = newResult({ failures });
				else {
					// The server isn't the run's any more: Remove needn't wait while the page loads.
					release();
					const shownAfter = await reconnect(selection, problem.version ?? chosen.beforeVersion ?? target);
					// Its toast is the reloaded page's: the page now goes, and a toast with it.
					if (kept === failedRun) result = newResult({ failures }, selection, shownAfter);
					// The page it went back to may be one from before PR 7, with no capsule: then
					// the server list shows the failure, with its Retry. Not after a Dismiss, nor in
					// another window: the capsule shows it when this server's page opens again.
					if (!(await pageShows(failedRun, selection, shownAfter)) && kept === failedRun && stillOn(selection)) {
						kept = null;
						result = null;
						deps.fail(selection.origin, { kind: problem.kind, message: problem.message });
					}
				}
			} else if (problem.server) {
				deps.fail(selection.origin, { kind: problem.kind, message: problem.message });
			} else {
				result = newResult({ failures: [`This app: ${problem.message}`] });
			}
		} finally { release(); }
	}

	/** The page's everything control and the capsule's Retry: main's own dialog asks, and only its
	 *  Update starts anything. The slot is taken before any await, so two calls can't both ask. */
	async function askThenRun(selection, plan, options) {
		const { confirmed, keyboard } = await confirmedInApp(selection, plan);
		// `dialog`: this answer is the dialog's (the page puts focus back as T3 does after one).
		if (!confirmed) return { started: false, keyboard, dialog: true };
		kept = null;
		result = null;
		void runInPage(selection, plan, { ...options, keyboard }).catch(() => {});
		return { started: true, keyboard, dialog: true };
	}

	return {
		status,
		/** The page's everything control: main shows its own Update everything dialog over that
		 *  window. Resolves { started }, or { error } for the page's toast. */
		async everything() {
			if (run || asking) return { error: BUSY };
			if (tooSoon()) return { error: TOO_SOON };
			const selection = deps.selection();
			if (!selection) return { error: NO_SERVER };
			asking = true;
			try {
				// The plan talks to the server with its bearer; the dialog alone doesn't, so the
				// hold is the run's again only once Update is pressed (runInPage).
				const release = hold(selection.origin);
				let made;
				try { made = await makePlan(selection); } finally { release(); }
				if (made.error) return { error: { title: made.error.title, detail: made.error.detail } };
				// Only the server moves when this app has nothing newer (revision PR 8).
				return await askThenRun(selection, made.plan, { serverOnly: made.plan.serverOnly });
			} finally { asking = false; }
		},
		/** The page has drawn the capsule for the run (or the failure) main waits on. `from` is
		 *  { win, generation }, the window and page load the signal came from (deps.page). */
		ready(from) {
			for (const wait of [...waits]) {
				if (deps.page && (from?.win !== wait.win || !(from.generation >= wait.generation))) continue;
				wait.settle(true);
			}
		},
		/** The page's Restart in Ns: Later keeps this app as it is. */
		later() { decideRestart?.(false); },
		/** The capsule's Retry: main's dialog asks again, for that server only, with the same
		 *  version and the same checks as the first plan. */
		async retry() {
			if (run || asking) return { error: BUSY };
			if (tooSoon()) return { error: TOO_SOON };
			const selection = deps.selection();
			if (!kept || !selection || selection.origin !== kept.origin) return { error: NOTHING_TO_RETRY };
			asking = true;
			const failed = kept;
			try {
				const release = hold(selection.origin);
				let made;
				try { made = await makePlan(selection, { target: failed.target, serverOnly: true }); } finally { release(); }
				// Dismissed while main planned: nothing to retry any more.
				if (kept !== failed) return { started: false };
				if (made.done) {
					// Back on the target by now: done (T3's retryFailedUpdateRunServers).
					if (kept === failed) kept = null;
					result = newResult({ updatedServers: 1 });
					return { started: false };
				}
				if (made.error) {
					if (made.error.kind === "pair") {
						// The server list says it, with its Pair again: once, not also in a toast.
						kept = null;
						deps.fail(selection.origin, { kind: "pair", message: made.error.detail });
						return { started: false };
					}
					// The capsule keeps the run's own failure; the toast says why Retry didn't start.
					return { error: { title: made.error.title, detail: made.error.detail } };
				}
				return await askThenRun(selection, made.plan, { serverOnly: true });
			} finally { asking = false; }
		},
		/** The capsule's Dismiss: forget a run that ended on a failure, also while main waits for
		 *  the page to show it. */
		dismiss() {
			if (run || !kept) return;
			const dropped = kept;
			kept = null;
			for (const wait of [...waits]) if (wait.source === dropped) wait.settle(false);
		},
		/** The result toast, once (also after the restart that finished the run), for the page that
		 *  stays (`from`, as for ready()). */
		takeResult(from) {
			const taken = resultFor(from);
			if (taken) result = null;
			return taken && { localVersion: taken.localVersion, updatedServers: taken.updatedServers, failures: taken.failures };
		},
		/** A run, or its confirmation, is going: the plain install and the menu wait. */
		running: () => run !== null || asking,
		/** Main recovered from an installer error (T3's recoverFailedInstall): a run waiting on its
		 *  app install ends with a retryable failure instead of "Restarting" for good. */
		installFailed() {
			const fail = run?.step === "restarting" ? run.installFailed : null;
			if (fail) void fail();
		},
		/** The origin a run is updating, from its confirmation to its end, or null. */
		server: () => holding?.origin ?? null,
		check() {
			if (!run) deps.updater.check();
		},
		download() {
			// Also a retry of a failed download (T3's download retry), never a dead click.
			if (!run && hasDownloadableOffer(deps.updater.state())) deps.updater.download();
		},
		/** Settings' This app Install (revision PR 5): only this app, after T3's confirm. Main asks,
		 *  never the page, and the page names nothing. Resolves once the confirm is answered. */
		async installApp() {
			if (run || asking || !hasInstallableDownload(deps.updater.state())) return;
			asking = true;
			let choice;
			try {
				const state = deps.updater.state();
				choice = await deps.confirm(installAppConfirmation(state.downloadedVersion ?? state.version));
			} finally {
				asking = false;
			}
			if (choice === 0 && !run && hasInstallableDownload(deps.updater.state())) deps.updater.install();
		},
		/** The page's install() (an older page): main asks in its own native dialog, and this
		 *  resolves once that is answered. */
		async install() {
			if (tooSoon()) return;
			if (run || asking) return;
			asking = true;
			let answered;
			const decided = new Promise((resolve) => { answered = resolve; });
			void start(answered).catch(() => {}).finally(answered);
			try { await decided; } finally { asking = false; }
		},
		offerRetry,
		/** After the launch: offer the pinned retry, or say that Try Again itself didn't install. */
		async afterLaunch(launch) {
			if (launch?.retry) return offerRetry(launch.retry);
			if (launch?.retryFailed) return retryFailed(launch.retryFailed);
		},
		/** The relaunch after an install: the server to reopen once, and the pinned retry to offer
		 *  (or, after a failed Try Again, the failure to report) if the app didn't change. */
		takeLaunch() {
			let saved = null;
			try { saved = deps.takeResult(); } catch { return null; }
			if (!saved || typeof saved.server !== "string" || typeof saved.target !== "string" || typeof saved.savedAt !== "number") return null;
			if (deps.now() - saved.savedAt > SAVED_RESULT_MAX_AGE_MS) return null;
			const applied = deps.appVersion === saved.target;
			// The in-page run's result toast, kept across the restart (T3's saved result,
			// updateEverythingRun.tsx:188-265 at df09ced7).
			if (applied && saved.inPage === true) result = newResult({ localVersion: saved.target, updatedServers: saved.updatedServers === 1 ? 1 : 0 });
			const missed = applied ? null : { target: saved.target, server: saved.server, updated: typeof saved.updated === "string" ? saved.updated : saved.server };
			return {
				server: saved.server,
				retry: saved.retried === true ? null : missed,
				...(saved.retried === true ? { retryFailed: missed } : {}),
			};
		},
	};
}

module.exports = { createUpdateEverything, serverLabel, confirmation, installAppConfirmation, HANDOFF_TIMEOUT_MS, RESTART_DELAY_MS, SAVED_RESULT_MAX_AGE_MS, INSTALL_VERSION_PATH, PAGE_READY_TIMEOUT_MS, ASK_COOLDOWN_MS };
