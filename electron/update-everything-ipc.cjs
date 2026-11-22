"use strict";

/* The main side of remote-preload.cjs: one channel, answered only for the current remote
 * window's main frame at its selected origin. Every action takes no argument, except that
 * install takes the page's dialog choice, { planId } (revision PR 7). Anything else, an
 * extra argument, another key, a non-plain object or a value of the wrong shape, is refused. */

const { atOrigin } = require("./remote-server.cjs");

const CHANNEL = "lh:desktop-update";
const ACTIONS = new Set(["status", "check", "download", "install", "install-app", "plan", "later", "retry", "dismiss", "take-result"]);
// The plan id main issued (randomUUID): the page can only hand it back.
const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `current()` is { win, origin } of the open remote window, or null. */
function fromRemoteWindow(event, current) {
	const open = current();
	if (!open || open.win.isDestroyed()) return false;
	const contents = open.win.webContents;
	return event.sender === contents && event.senderFrame === contents.mainFrame && atOrigin(event.senderFrame.url, open.origin);
}

/** The dialog's choice, exactly { planId: <uuid> } and nothing else, or null. */
function readChoice(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== 1 || keys[0] !== "planId") return null;
	const descriptor = Object.getOwnPropertyDescriptor(value, "planId");
	if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || !PLAN_ID.test(descriptor.value)) return null;
	return { planId: descriptor.value };
}

function registerDesktopUpdateIPC(ipcMain, { current, updateEverything }) {
	ipcMain.handle(CHANNEL, async (event, action, ...extra) => {
		if (!fromRemoteWindow(event, current) || typeof action !== "string" || !ACTIONS.has(action)) throw new Error("Untrusted desktop request.");
		const choice = action === "install" && extra.length === 1 ? readChoice(extra[0]) : null;
		if (extra.length > 0 && !choice) throw new Error("Untrusted desktop request.");
		if (action === "status") return updateEverything.status();
		if (action === "check") return void updateEverything.check();
		if (action === "download") return void updateEverything.download();
		if (action === "install-app") return void await updateEverything.installApp();
		if (action === "plan") return updateEverything.plan();
		if (action === "later") return void updateEverything.later();
		if (action === "retry") return void await updateEverything.retry();
		if (action === "dismiss") return void updateEverything.dismiss();
		if (action === "take-result") return updateEverything.takeResult();
		return choice ? updateEverything.install(choice) : updateEverything.install();
	});
}

module.exports = { registerDesktopUpdateIPC, fromRemoteWindow, readChoice, CHANNEL };
