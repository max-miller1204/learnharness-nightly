"use strict";

/* The main side of window.lh.chatgptSignIn (remote-preload.cjs): one channel, two actions,
 * answered only for the current remote window's main frame at its selected origin.
 * "start" takes at most a saved-account id the server itself issued (a UUID); "cancel"
 * ends that window's sign-in and takes nothing. */

const { fromRemoteWindow } = require("./update-everything-ipc.cjs");

const CHANNEL = "lh:chatgpt-sign-in";
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function valid(action, args) {
	if (action === "cancel") return args.length === 0;
	if (action !== "start" || args.length > 1) return false;
	return args[0] === undefined || (typeof args[0] === "string" && ACCOUNT_ID.test(args[0]));
}

/** `current()` is { win, origin } of the open remote window, or null. */
function registerChatGPTSignInIPC(ipcMain, { current, signIn, cancel }) {
	ipcMain.handle(CHANNEL, async (event, action, ...args) => {
		if (!fromRemoteWindow(event, current) || !valid(action, args)) throw new Error("Untrusted desktop request.");
		return action === "cancel" ? cancel() : signIn(args[0]);
	});
}

module.exports = { registerChatGPTSignInIPC, CHANNEL };
