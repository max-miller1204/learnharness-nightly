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

const { compareVersions } = require("./release-notes.cjs");

const EXACT = /^\d+\.\d+\.\d+(?:-[a-z]+\.\d{8}\.\d+)?$/;
const isNewerVersion = (a, b) => typeof a === "string" && typeof b === "string" && EXACT.test(a) && EXACT.test(b) && compareVersions(a, b) > 0;

const HANDOFF_TIMEOUT_MS = 32 * 60 * 1000;
const RESTART_DELAY_MS = 5_000;
const POLL_MS = 2_000;
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
 *   updater.installPinned(v)   quit and install exactly v (never a newer one)
 *   selection()                { origin, token } of the open remote window, or null
 *   request(origin, path, { token, method, body }) a fetch to that exact origin
 *   confirm({ message, detail, buttons, signal }) -> button index (native dialog)
 *   tell({ message, detail })  a native notice with one OK button
 *   progress(text)             cover the server's page with the ghost dashboard line
 *   fail(origin, { kind, message }) show the server window with Retry (or Pair again)
 *   reconnect(origin)          reopen the server's page (after Later)
 *   saveResult(record) / takeResult()  userData file for the next launch
 *   now(), sleep(ms), timeoutSignal(ms) (defaults to AbortSignal.timeout)
 */
function createUpdateEverything(deps) {
	let run = null; // { target, step: "downloading" | "updating" | "restarting" }
	let asking = false;

	function status() {
		const state = deps.updater.state();
		if (run) return { version: deps.appVersion, target: run.target, phase: run.step === "downloading" ? "downloading" : "updating", error: null };
		return {
			version: deps.appVersion,
			target: typeof state.version === "string" ? state.version : null,
			phase: state.status,
			error: state.status === "error" ? "Couldn’t check for updates. Try again later." : null,
		};
	}

	async function serverUpdates(origin, token) {
		const response = await deps.request(origin, "/api/updates", { token });
		if (response.status === 401) throw new RunProblem("This desktop is no longer paired with the server.", { server: true, kind: "pair" });
		const body = response.ok ? await readJSON(response) : null;
		if (!body || typeof body.runningVersion !== "string") throw new RunProblem("Couldn’t read the server’s version. Try again.", { server: true });
		return body;
	}

	async function runningCount(origin, token) {
		try {
			const response = await deps.request(origin, "/api/updates/running", { token });
			const body = response.ok ? await readJSON(response) : null;
			return Array.isArray(body?.items) ? body.items.length : 0;
		} catch { return 0; }
	}

	/** Ask the server for exactly `target`, then wait for its launcher to keep it. */
	async function updateServer(selection, label, target) {
		const { origin, token } = selection;
		run.step = "updating";
		deps.progress(`Updating ${label} to ${target}… This can take a few minutes.`);
		let response;
		try {
			response = await deps.request(origin, INSTALL_VERSION_PATH, { token, method: "POST", body: { version: target } });
		} catch {
			throw new RunProblem(`Couldn’t reach ${label}. Nothing was changed.`, { server: true });
		}
		const body = await readJSON(response);
		if (response.status === 404) throw new RunProblem(`${label} runs a LearnHarness without Update everything. Update it from its own Settings first.`, { server: true });
		if (response.status === 401) throw new RunProblem("This desktop is no longer paired with the server.", { server: true, kind: "pair" });
		if (!response.ok) throw new RunProblem(`${label} can’t update: ${typeof body?.error === "string" ? body.error : `HTTP ${response.status}`} Nothing was changed.`, { server: true });
		const before = typeof body?.instance === "string" ? body.instance : null;
		const deadline = deps.now() + HANDOFF_TIMEOUT_MS;
		while (deps.now() < deadline) {
			try {
				const health = await deps.request(origin, "/api/health", {});
				const healthy = health.ok && (await readJSON(health))?.version === target;
				const state = await serverUpdates(origin, token);
				if (healthy && state.runningVersion === target && state.committed === true) return;
				if (state.instance === before && state.status === "error") {
					throw new RunProblem(`${label} couldn’t start the update: ${state.message ?? "the launcher refused it."} Your app wasn’t changed.`, { server: true });
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
		throw new RunProblem(`${label} wasn’t back after ${HANDOFF_TIMEOUT_MS / 60_000} minutes. Your app wasn’t changed.`, { server: true });
	}

	/** `answered` resolves the page's install() once the confirmation is decided (or skipped). */
	async function start(answered) {
		const selection = deps.selection();
		if (!selection) return;
		const label = serverLabel(selection.origin);
		let target;
		try {
			target = await deps.updater.pin();
		} catch {
			target = null;
		}
		if (!target || !isNewerVersion(target, deps.appVersion)) {
			deps.tell({ message: "LearnHarness is up to date.", detail: "No newer version of this app was found." });
			return;
		}
		let server;
		try {
			server = await serverUpdates(selection.origin, selection.token);
		} catch (error) {
			deps.tell({ message: "Couldn’t update everything.", detail: error.message });
			return;
		}
		if (isNewerVersion(server.runningVersion, target)) {
			deps.tell({ message: "Couldn’t update everything.", detail: `${label} runs ${server.runningVersion}, newer than this app’s update (${target}). Check for updates again.` });
			return;
		}
		const serverBehind = compareVersions(server.runningVersion, target) < 0;
		const running = serverBehind ? await runningCount(selection.origin, selection.token) : 0;
		const text = confirmation({ label, target, serverBehind, running });
		const choice = await deps.confirm(text);
		answered();
		if (choice !== 0) return;

		run = { target, step: "downloading" };
		try {
			try {
				await deps.updater.downloadPinned(target);
			} catch {
				throw new RunProblem("Couldn’t download the app update. Nothing was changed.");
			}
			if (serverBehind) await updateServer(selection, label, target);
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
				if (serverBehind) deps.reconnect(selection.origin);
				return;
			}
			deps.saveResult({ savedAt: deps.now(), server: selection.origin, from: deps.appVersion, target });
			deps.updater.installPinned(target);
		} catch (error) {
			run = null;
			const problem = error instanceof RunProblem ? error : new RunProblem("Update everything stopped. Nothing was changed.");
			if (problem.server) deps.fail(selection.origin, { kind: problem.kind, message: problem.message });
			else deps.tell({ message: "Couldn’t update everything.", detail: problem.message });
		}
	}

	return {
		status,
		running: () => run !== null,
		check() {
			if (!run) deps.updater.check();
		},
		download() {
			if (!run && deps.updater.state().status === "available") deps.updater.download();
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
		/** The relaunch after an install: the server to reopen once, and a notice if the app didn't change. */
		takeLaunch() {
			let saved = null;
			try { saved = deps.takeResult(); } catch { return null; }
			if (!saved || typeof saved.server !== "string" || typeof saved.target !== "string" || typeof saved.savedAt !== "number") return null;
			if (deps.now() - saved.savedAt > SAVED_RESULT_MAX_AGE_MS) return null;
			const applied = deps.appVersion === saved.target;
			return {
				server: saved.server,
				notice: applied ? null : {
					message: "The app update didn’t finish.",
					detail: `LearnHarness is still on ${deps.appVersion} and ${serverLabel(saved.server)} is on ${saved.target}. Use Update everything to try again.`,
				},
			};
		},
	};
}

module.exports = { createUpdateEverything, serverLabel, confirmation, HANDOFF_TIMEOUT_MS, RESTART_DELAY_MS, SAVED_RESULT_MAX_AGE_MS, INSTALL_VERSION_PATH };
