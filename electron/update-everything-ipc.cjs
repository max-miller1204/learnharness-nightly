"use strict";

/* The main side of remote-preload.cjs: one channel of zero-argument actions, answered only for
 * the current remote window's main frame at its selected origin. Any argument is refused. None of
 * them starts a run by itself: "everything" and "retry" make main show its own Update everything
 * dialog (electron/update-everything-dialog.cjs), and only that dialog's Update starts one. */

const { atOrigin } = require("./remote-server.cjs");

const CHANNEL = "lh:desktop-update";
/** Main's push of the status the "status" action answers, to the remote window's main frame. */
const STATUS_CHANNEL = "lh:desktop-update-status";
const ACTIONS = new Set(["status", "check", "download", "install", "install-app", "everything", "ready", "later", "retry", "dismiss", "take-result"]);

/** `current()` is { win, origin } of the open remote window, or null. */
function fromRemoteWindow(event, current) {
	const open = current();
	if (!open || open.win.isDestroyed()) return false;
	const contents = open.win.webContents;
	return event.sender === contents && event.senderFrame === contents.mainFrame && atOrigin(event.senderFrame.url, open.origin);
}

/** `pageGeneration(win)` numbers the window's page loads (update-everything.cjs's deps.page), so
 *  ready() says which page drew the capsule. */
function registerDesktopUpdateIPC(ipcMain, { current, updateEverything, pageGeneration = () => 0 }) {
	ipcMain.handle(CHANNEL, async (event, action, ...extra) => {
		if (!fromRemoteWindow(event, current) || typeof action !== "string" || !ACTIONS.has(action) || extra.length > 0) throw new Error("Untrusted desktop request.");
		// Which window and page load asks: the result toast waits for the page that stays.
		const from = () => {
			const { win } = current();
			return { win, generation: pageGeneration(win) };
		};
		if (action === "status") return updateEverything.status(from());
		if (action === "check") return void updateEverything.check();
		if (action === "download") return void updateEverything.download();
		if (action === "install-app") return void await updateEverything.installApp();
		if (action === "everything") return updateEverything.everything();
		if (action === "ready") return void updateEverything.ready(from());
		if (action === "later") return void updateEverything.later();
		if (action === "retry") return updateEverything.retry();
		if (action === "dismiss") return void updateEverything.dismiss();
		if (action === "take-result") return updateEverything.takeResult(from());
		return updateEverything.install();
	});
}

/** T3's push on every updater state change (apps/desktop/src/updates/DesktopUpdates.ts:425-434
 *  at df09ced7, `setState` then `emitState`): the same status "status" answers, sent to the
 *  current remote window's main frame only, and only while it is still at the selected origin.
 *  The page's read stays for a late subscriber and for the run's own steps. */
function createStatusPush({ current, updateEverything, pageGeneration = () => 0 }) {
	return function pushStatus() {
		try {
			const open = current();
			if (!open || open.win.isDestroyed()) return false;
			const frame = open.win.webContents.mainFrame;
			if (!frame || !atOrigin(frame.url, open.origin)) return false;
			frame.send(STATUS_CHANNEL, updateEverything.status({ win: open.win, generation: pageGeneration(open.win) }));
			return true;
		} catch {
			/* A window mid-teardown: the page's next read covers it. */
			return false;
		}
	};
}

module.exports = { registerDesktopUpdateIPC, createStatusPush, fromRemoteWindow, CHANNEL, STATUS_CHANNEL };
