"use strict";

/*
 * main.cjs's updater actions for Update everything (roadmap item 23 PR 2) and
 * the app menu's check while connected to a server, with the updater and the
 * dialogs injected so tests can drive them without Electron.
 *
 * deps:
 *   updater()            electron-updater's autoUpdater, or null when updates are off
 *   state()              main's update snapshot (electron/update-machine.cjs: { status, version, ... })
 *   report(status)       "error": a failed check (T3's check-failure state)
 *   downloadStarted(version)  "downloading" `version` at 0%, as the Download button does
 *   downloadFailed(version)   the download failed: offer `version` again with T3's retry
 *   installing()         an install is already under way
 *   startInstall()       quit and install the staged update, no re-check
 *   adoptNotes(info)     keep the offered version's release notes
 *   appVersion           this app's version
 *   compareVersions(a, b)
 *   show(options)        dialog.showMessageBox, resolving { response }
 *   download()           the menu's Download (downloadUpdateNow)
 *   install()            the menu's Restart (installUpdateNow, which re-checks)
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

	/** T3's native dialogs for the app menu's check (DesktopApplicationMenu.ts:71-165 at 3ce2145). */
	async function checkNatively() {
		const show = deps.show;
		// An install is under way: its own updater errors must not meet a check's.
		if (deps.installing()) return;
		if (deps.running()) {
			// The run already pinned, downloaded and owns the restart.
			await show({ type: "info", title: "Update in progress", message: "Update everything is running.", detail: "LearnHarness restarts by itself when the server is back.", buttons: ["OK"] });
			return;
		}
		const updater = deps.updater();
		if (!updater) {
			await show({ type: "info", title: "Updates unavailable", message: "Automatic updates are not available right now.", detail: "Automatic updates are not available in this build.", buttons: ["OK"] });
			return;
		}
		try {
			await updater.checkForUpdates();
		} catch (err) {
			deps.log(`update check failed: ${err?.message ?? err}`);
			deps.report("error");
		}
		const { status, version } = deps.state();
		if (status === "up-to-date") {
			await show({ type: "info", title: "You're up to date!", message: `LearnHarness ${deps.appVersion} is currently the newest version available.`, buttons: ["OK"] });
		} else if (status === "available") {
			const { response } = await show({
				type: "info", title: "Update available",
				message: version ? `LearnHarness ${version} is available.` : "A new version of LearnHarness is available.",
				detail: `You're running LearnHarness ${deps.appVersion}.`, buttons: ["Download", "Later"], defaultId: 0, cancelId: 1,
			});
			if (response === 0 && !deps.running()) deps.download();
		} else if (status === "downloading") {
			await show({ type: "info", title: "Update downloading", message: version ? `LearnHarness ${version} is already downloading.` : "A new version of LearnHarness is already downloading.", buttons: ["OK"] });
		} else if (status === "downloaded") {
			const { response } = await show({
				type: "info", title: "Update ready",
				message: version ? `LearnHarness ${version} is ready to install.` : "A new version of LearnHarness is ready to install.",
				detail: "LearnHarness will restart to install it. Any running tasks will be interrupted.", buttons: ["Restart", "Later"], defaultId: 0, cancelId: 1,
			});
			// A run may have started while the dialog was open.
			if (response === 0 && !deps.running()) void deps.install();
		} else if (status === "error") {
			await show({ type: "warning", title: "Update check failed", message: "Could not check for updates.", detail: "An unknown error occurred. Please try again later.", buttons: ["OK"] });
		}
	}

	return { pin, downloadPinned, downloadExact, installPinned, checkNatively };
}

module.exports = { createUpdateActions };
