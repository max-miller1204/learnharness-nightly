"use strict";

/* The main side of remote-preload.cjs: one channel, five zero-argument actions,
 * answered only for the current remote window's main frame at its selected origin. */

const { atOrigin } = require("./remote-server.cjs");

const CHANNEL = "lh:desktop-update";
const ACTIONS = new Set(["status", "check", "download", "install", "install-app"]);

/** `current()` is { win, origin } of the open remote window, or null. */
function fromRemoteWindow(event, current) {
	const open = current();
	if (!open || open.win.isDestroyed()) return false;
	const contents = open.win.webContents;
	return event.sender === contents && event.senderFrame === contents.mainFrame && atOrigin(event.senderFrame.url, open.origin);
}

function registerDesktopUpdateIPC(ipcMain, { current, updateEverything }) {
	ipcMain.handle(CHANNEL, async (event, action, ...extra) => {
		if (!fromRemoteWindow(event, current) || !ACTIONS.has(action) || extra.length > 0) throw new Error("Untrusted desktop request.");
		if (action === "status") return updateEverything.status();
		if (action === "check") return void updateEverything.check();
		if (action === "download") return void updateEverything.download();
		if (action === "install-app") return void await updateEverything.installApp();
		return updateEverything.install();
	});
}

module.exports = { registerDesktopUpdateIPC, fromRemoteWindow, CHANNEL };
