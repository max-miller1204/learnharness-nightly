"use strict";

/* The main side of window.lh.chatgptSignIn (remote-preload.cjs): one channel, one action,
 * answered only for the current remote window's main frame at its selected origin. The only
 * argument is an optional saved-account id the server itself issued (a UUID). */

const { fromRemoteWindow } = require("./update-everything-ipc.cjs");

const CHANNEL = "lh:chatgpt-sign-in";
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `current()` is { win, origin } of the open remote window, or null; `signIn(accountId)` runs it. */
function registerChatGPTSignInIPC(ipcMain, { current, signIn }) {
	ipcMain.handle(CHANNEL, async (event, ...args) => {
		const [accountId] = args;
		if (!fromRemoteWindow(event, current) || args.length > 1 ||
			(accountId !== undefined && (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)))) {
			throw new Error("Untrusted desktop request.");
		}
		return signIn(accountId);
	});
}

module.exports = { registerChatGPTSignInIPC, CHANNEL };
