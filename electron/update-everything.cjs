"use strict";

/*
 * Update everything (roadmap item 23 PR 2, docs/specs/desktop-server-list.md):
 * from the desktop app's window onto a self-hosted server, bring that server
 * to the exact release this app installs, wait until its launcher has kept
 * it, then install and restart this app. Main owns every step. The remote
 * page only reaches the four zero-argument methods in remote-preload.cjs.
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

// The ghost dashboard's name for a server: its first label, or a whole IP.
const { hostLabel: serverLabel } = require("./skeleton.cjs");

function plural(count, one, other) {
	return `${count} ${count === 1 ? one : other}`;
}

/** The native confirmation's text (plan approved 2026-11-18). */
function confirmation({ label, target, serverBehind, running }) {
	if (!serverBehind) {
		return {
			message: `Restart LearnHarness to update to ${target}?`,
			detail: `${label} already runs ${target}. Only this app restarts.`,
			buttons: ["Restart", "Cancel"],
		};
	}
	const stops = running > 0 ? ` ${plural(running, "running task", "running tasks")} there will stop.` : "";
	return {
		message: "Update everything?",
		detail: `Update ${label} and this app to ${target}.\n\n1. ${label} updates first and restarts. This takes a few minutes.${stops}\n2. Once ${label} is back, this app restarts to finish.`,
		buttons: ["Update everything", "Cancel"],
	};
}

/** Settings' This app Install: T3's install confirm (getDesktopUpdateInstallConfirmationMessage,
 *  apps/web/src/components/desktopUpdate.logic.ts:180-197 at df09ced7), worded as
 *  components/install-update-dialog.tsx words it, in a native dialog. */
function installAppConfirmation(version) {
	return {
		message: `Install update${version ? ` ${version}` : ""} and restart LearnHarness?`,
		detail: "Any running tasks will be interrupted. Make sure you're ready before continuing.",
		buttons: ["Install and restart", "Cancel"],
	};
}

class RunProblem extends Error {
	/** `server` failures leave the app as it is and offer Retry (or Pair again) and Switch server…. */
	constructor(message, { server = false, kind = "retry" } = {}) {
		super(message);
		this.server = server;
		this.kind = kind;
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
 *   reconnect(origin, version) uncover the server's page and show `version` in the same window, loaded once (after Later)
 *   saveResult(record) / takeResult()  userData file for the next launch
 *   now(), sleep(ms), timeoutSignal(ms) (defaults to AbortSignal.timeout)
 */
function createUpdateEverything(deps) {
	let run = null; // { target, step: "downloading" | "updating" | "restarting" }
	let asking = false;
	// The server a run (or its confirmation) talks to with its bearer.
	let against = null;

	function status() {
		const state = deps.updater.state();
		// The sidebar's progress ring: how far this app's own download is, or null (not downloading, or no size).
		const downloadPercent = state.status === "downloading" && typeof state.downloadPercent === "number" ? state.downloadPercent : null;
		// A run shows no notes, also in its download step, which the page can't tell from a
		// plain download (T3's `!isRunningEverything`, SidebarUpdatePill.tsx:279-280).
		if (run) return { version: deps.appVersion, target: run.target, phase: run.step === "downloading" ? "downloading" : "updating", error: null, downloadPercent, releaseNotes: [], omittedReleaseCount: 0 };
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
	async function updateServer(selection, label, target, before) {
		const { origin, token } = selection;
		run.step = "updating";
		deps.progress(origin, `Updating ${label} to ${target}… This can take a few minutes.`);
		let asked = false;
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
			if (response.status === 404) throw new RunProblem(`${label} runs a LearnHarness without Update everything. Update it from its own Settings first.`, { server: true });
			if (response.status === 401) throw new RunProblem("This desktop is no longer paired with the server.", { server: true, kind: "pair" });
			if (!response.ok) throw new RunProblem(`${label} can’t update: ${typeof body?.error === "string" ? body.error : `HTTP ${response.status}`} Nothing was changed.`, { server: true });
			asked = true;
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
				if (!state) throw new Error("not back yet");
				if (healthy && state.runningVersion === target && state.committed === true) return;
				if (attempt && state.pinned?.id === attempt && typeof state.pinned.error === "string") {
					throw new RunProblem(`${label} couldn’t start the update: ${state.pinned.error} Your app wasn’t changed.`, { server: true });
				}
				const started = state.pinned?.version === target && !state.pinned.error;
				if (routeError && state.instance === before && !started) {
					routeErrors += 1;
					if (routeErrors >= ROUTE_ERROR_LIMIT) throw new RunProblem(`${label} can’t update: HTTP ${routeError}. Nothing was changed.`, { server: true });
				} else {
					routeErrors = 0;
				}
				if (state.instance !== before && state.runningVersion !== target && state.notice?.kind === "rolled-back" && state.notice.version === target) {
					throw new RunProblem(`${label} couldn’t start ${target} and went back to ${state.runningVersion}. Your app wasn’t changed.`, { server: true });
				}
			} catch (error) {
				if (error instanceof RunProblem) throw error;
				/* Restarting: keep waiting. */
			}
			await deps.sleep(POLL_MS);
		}
		throw new RunProblem(asked
			? `${label} wasn’t back after ${HANDOFF_TIMEOUT_MS / 60_000} minutes. Your app wasn’t changed.`
			: `Couldn’t reach ${label} for ${HANDOFF_TIMEOUT_MS / 60_000} minutes. Your app wasn’t changed.`, { server: true });
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
				buttons: ["Try Again", "Later"],
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
		against = selection.origin;
		try { await startWith(selection, answered); } finally { against = null; }
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
		if (choice !== 0) return;

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

	return {
		status,
		/** A run, or its confirmation, is going: the plain install and the menu wait. */
		running: () => run !== null || asking,
		/** Main recovered from an installer error (T3's recoverFailedInstall): a run waiting on its
		 *  app install ends with a retryable failure instead of "Restarting" for good. */
		installFailed() {
			const fail = run?.step === "restarting" ? run.installFailed : null;
			if (fail) void fail();
		},
		/** The origin a run is updating, from its confirmation to its end, or null. */
		server: () => against,
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
		/** The page's install(): resolves once the confirmation is answered. */
		async install() {
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
			const missed = applied ? null : { target: saved.target, server: saved.server, updated: typeof saved.updated === "string" ? saved.updated : saved.server };
			return {
				server: saved.server,
				retry: saved.retried === true ? null : missed,
				...(saved.retried === true ? { retryFailed: missed } : {}),
			};
		},
	};
}

module.exports = { createUpdateEverything, serverLabel, confirmation, installAppConfirmation, HANDOFF_TIMEOUT_MS, RESTART_DELAY_MS, SAVED_RESULT_MAX_AGE_MS, INSTALL_VERSION_PATH };
