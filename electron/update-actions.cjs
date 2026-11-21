"use strict";

/*
 * main.cjs's updater actions for Update everything (roadmap item 23 PR 2) and
 * the app menu's Check for Updates… (in the local window and onto a server,
 * docs/specs/t3-style-updates.md revision PR 6), with the updater and the
 * dialogs injected so tests can drive them without Electron.
 *
 * deps:
 *   updater()            electron-updater's autoUpdater, or null when updates are off
 *   state()              main's update snapshot (electron/update-machine.cjs: { status, version, ... })
 *   check()              main's check (checkForUpdates), the sidebar's: resolves { checked }
 *   activate()           show and focus the app's window (starting to reopen one), before the
 *                        check; the window to parent the dialog on, or null
 *   downloadStarted(version)  "downloading" `version` at 0%, as the Download button does
 *   downloadFailed(version)   the download failed: offer `version` again with T3's retry
 *   installing()         an install is already under way
 *   startInstall()       quit and install the staged update, no re-check
 *   adoptNotes(info)     keep the offered version's release notes
 *   appVersion           this app's version
 *   compareVersions(a, b)
 *   show(options, parent) dialog.showMessageBox over `parent`, or with no parent; resolving { response }
 *   download(version)    the menu's Download (downloadUpdateNow), of exactly `version`; resolves
 *                        { superseded: true } when the feed now names another version
 *   install(version)     the menu's Restart (installUpdateNow, which re-checks), of exactly
 *                        `version`; resolves { superseded: true } likewise
 *   running()            an Update everything run (or its confirmation) is going
 *   pinFeed(version)     make the feed offer exactly `version` (null: the newest again)
 *   log(line), wait(ms)
 */
function createUpdateActions(deps) {
	const wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

	/** Re-check the feed; the newest offered version newer than this app, or null. */
	async function pin() {
		const updater = deps.updater();
		if (!updater) return null;
		const result = await updater.checkForUpdates();
		const info = result?.updateInfo;
		if (typeof info?.version !== "string" || deps.compareVersions(info.version, deps.appVersion) <= 0) return null;
		deps.adoptNotes(info);
		return info.version;
	}

	/** Make sure exactly `target` is downloaded (electron-updater checks its SHA-512). */
	async function downloadPinned(target) {
		const updater = deps.updater();
		if (!updater || deps.installing()) throw new Error("The updater is busy or unavailable.");
		const ready = () => deps.state().status === "downloaded" && deps.state().version === target;
		// A download of an older offer already under way finishes first; then fetch the pinned one.
		for (let attempt = 0; attempt < 2 && !ready(); attempt++) {
			let listener;
			const downloaded = new Promise((resolve) => { listener = resolve; updater.once("update-downloaded", listener); });
			try {
				// The ring starts at 0 here too, not at the first progress event (docs/specs/update-control.md).
				deps.downloadStarted?.(target);
				await updater.downloadUpdate();
				await Promise.race([downloaded, wait(1000)]);
			} catch (error) {
				// electron-updater empties its cache when it starts another version, so an older
				// download shown as ready is gone too: offer the pinned one again, to retry.
				deps.downloadFailed?.(target);
				throw error;
			} finally {
				updater.removeListener("update-downloaded", listener);
			}
		}
		if (!ready()) throw new Error(`Downloaded ${deps.state().version}, not the pinned ${target}.`);
	}

	/** The app-only retry of a pinned version that didn't install: check the
	 *  feed for exactly `target` (not the newest), then download it. */
	async function downloadExact(target) {
		const updater = deps.updater();
		if (!updater) throw new Error("The updater is unavailable.");
		deps.pinFeed(target);
		try {
			// electron-updater hands back a check already in flight (the startup check, say),
			// which read the newest version before the pin: then check once more, pinned.
			let result = await updater.checkForUpdates();
			if (result?.updateInfo?.version !== target) result = await updater.checkForUpdates();
			const offered = result?.updateInfo?.version;
			if (offered !== target) throw new Error(`The feed offered ${offered ?? "nothing"}, not ${target}.`);
			deps.adoptNotes(result.updateInfo);
			await downloadPinned(target);
		} finally {
			deps.pinFeed(null);
		}
	}

	/** Quit and install exactly `target`, with no re-check. */
	function installPinned(target) {
		const state = deps.state();
		if (!deps.updater() || deps.installing() || state.status !== "downloaded" || state.version !== target) throw new Error(`Version ${target} isn't ready to install.`);
		deps.startInstall();
	}

	/**
	 * App menu → Check for Updates…: T3 Code's native dialogs, ported from
	 * apps/desktop/src/window/DesktopApplicationMenu.ts at df09ced7 (MIT, Copyright (c) 2026 T3
	 * Tools Inc.): handleCheckForUpdatesMenuClick (:150-171) and checkForUpdatesFromMenu (:71-148).
	 * The check, Download and Restart are main's own (the sidebar's paths), so the state, the
	 * sidebar and Settings follow, and the menu raises no toast. The dialogs' text is fixed: the
	 * state's message is one of main's fixed lines, never an updater error. LearnHarness's own: no
	 * dialog while an install is under way, "Update in progress" while Update everything runs,
	 * which owns the updater, and Download and Restart act only on the state their dialog showed;
	 * when main then refuses one for another version, the dialog for the new state follows.
	 */
	async function checkNatively() {
		const show = deps.show;
		if (deps.installing()) return;
		if (deps.running()) {
			await show({ type: "info", title: "Update in progress", message: "Update everything is running.", detail: "LearnHarness restarts by itself when the server is back.", buttons: ["OK"] });
			return;
		}
		// T3's "Updates unavailable" (:155-166), before any window opens.
		if (!deps.updater()) {
			await show({ type: "info", title: "Updates unavailable", message: "Automatic updates are not available right now.", detail: "Automatic updates are not available in this build.", buttons: ["OK"] });
			return;
		}
		// T3 activates the window first (:168-170); a failure there never stops the check.
		let parent = null;
		try { parent = (await deps.activate()) ?? null; } catch { /* the dialog shows without a parent */ }
		const { checked } = await deps.check();
		if (deps.installing()) return;
		const state = deps.state();
		// A click whose own check didn't run (another check or a download of ours is running) shows
		// what T3's state would then say: "Update downloading" during a download, else nothing (a
		// check under way reads "checking" in T3). Never a stale offer from before that check.
		if (!checked && state.status !== "downloading") return;
		await dialogFor(state, parent, true);
	}

	/** The dialog for `state` (T3's checkForUpdatesFromMenu branches). `followUp`: when main refuses
	 *  its Download or Restart because the feed now names another version, the dialog for the new
	 *  state follows once, so the user sees why. */
	async function dialogFor(state, parent, followUp) {
		const show = deps.show;
		const offered = state.availableVersion ?? state.version ?? null;
		/** A button acts only on the state its dialog showed: the same status and version, with no
		 *  Update everything run, so it never downloads or installs a version it didn't name. */
		const unchanged = (version) => {
			const now = deps.state();
			return !deps.running() && now.status === state.status && (now.downloadedVersion ?? now.availableVersion ?? now.version ?? null) === version;
		};
		const superseded = async (result) => {
			if (followUp && result?.superseded) await dialogFor(deps.state(), parent, false);
		};
		if (state.status === "up-to-date") {
			// :76-84
			await show({ type: "info", title: "You're up to date!", message: `LearnHarness ${deps.appVersion} is currently the newest version available.`, buttons: ["OK"] }, parent);
		} else if (state.status === "available") {
			// :85-102
			const { response } = await show({
				type: "info", title: "Update available",
				message: offered ? `LearnHarness ${offered} is available.` : "A new version of LearnHarness is available.",
				detail: `You're running LearnHarness ${deps.appVersion}.`, buttons: ["Download", "Later"], defaultId: 0, cancelId: 1,
			}, parent);
			if (response === 0 && offered && unchanged(offered)) await superseded(await deps.download(offered));
		} else if (state.status === "downloading") {
			// :103-113
			await show({ type: "info", title: "Update downloading", message: offered ? `LearnHarness ${offered} is already downloading.` : "A new version of LearnHarness is already downloading.", buttons: ["OK"] }, parent);
		} else if (state.status === "downloaded") {
			// :114-127
			const version = state.downloadedVersion ?? offered;
			const { response } = await show({
				type: "info", title: "Update ready",
				message: version ? `LearnHarness ${version} is ready to install.` : "A new version of LearnHarness is ready to install.",
				detail: "LearnHarness will restart to install it. Any running tasks will be interrupted.", buttons: ["Restart", "Later"], defaultId: 0, cancelId: 1,
			}, parent);
			if (response === 0 && version && unchanged(version)) await superseded(await deps.install(version));
		} else if (state.status === "error") {
			// :128-136
			await show({ type: "warning", title: "Update check failed", message: "Could not check for updates.", detail: state.message ?? "An unknown error occurred. Please try again later.", buttons: ["OK"] }, parent);
		}
		// "idle" shows nothing, as in T3.
	}

	return { pin, downloadPinned, downloadExact, installPinned, checkNatively };
}

module.exports = { createUpdateActions };
