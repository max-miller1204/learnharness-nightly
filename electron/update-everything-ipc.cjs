"use strict";

/* The main side of remote-preload.cjs: one channel of zero-argument actions, answered only for
 * the current remote window's main frame at its selected origin. Any argument is refused. None of
 * them starts a run by itself: "everything" and "retry" make main show its own Update everything
 * dialog (electron/update-everything-dialog.cjs), and only that dialog's Update starts one. */

const { atOrigin } = require("./remote-server.cjs");

const CHANNEL = "lh:desktop-update";
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
		if (action === "status") return updateEverything.status();
		if (action === "check") return void updateEverything.check();
		if (action === "download") return void updateEverything.download();
		if (action === "install-app") return void await updateEverything.installApp();
		if (action === "everything") return updateEverything.everything();
		if (action === "ready") {
			const { win } = current();
			return void updateEverything.ready({ win, generation: pageGeneration(win) });
		}
		if (action === "later") return void updateEverything.later();
		if (action === "retry") return updateEverything.retry();
		if (action === "dismiss") return void updateEverything.dismiss();
		if (action === "take-result") return updateEverything.takeResult();
		return updateEverything.install();
	});
}

module.exports = { registerDesktopUpdateIPC, fromRemoteWindow, CHANNEL };
