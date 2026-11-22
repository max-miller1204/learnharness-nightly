"use strict";

/*
 * Main's own Update everything dialog (docs/specs/t3-style-updates.md, revision PR 7): T3's
 * dialog (UpdateEverythingDialog.tsx at df09ced7) drawn over the window onto a self-hosted
 * server, from the app's own files, never by the server's page. It is the run's consent: the
 * page can only ask main to show it (window.lh.desktopUpdate.everything() or retry()), and
 * only its Update, a click or key press in this surface, starts or retries a run. The page
 * can't reach it: another WebContents, loaded from file:, sandboxed, with its own preload
 * (update-everything-dialog-preload.cjs) and a channel main answers only for this view's
 * main frame at this page. While it is up the page takes no keys. Its Update counts only from
 * UPDATE_ARM_MS after the dialog shows, so a click the page lured to where Update appears
 * doesn't start a run. Its answer says whether a key closed it, as T3 returns focus to the
 * trigger only then (UpdateEverythingDialog.tsx:78-82, `finalFocus` on a keyboard close).
 */

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PAGE = path.join(__dirname, "update-everything-dialog.html");
const PAGE_URL = pathToFileURL(PAGE).href;
const CHANNEL = "lh:update-everything-dialog";
const ACTIONS = new Set(["plan", "update", "cancel"]);
// The dialog's Update is ignored this long after it shows (its page disables it as long).
const UPDATE_ARM_MS = 500;
// One session for every dialog: its own, never the server page's.
const PARTITION = "update-everything-dialog";

/** `ipcMain`, `WebContentsView` and `session` are Electron's; `themeMode()` the app theme's mode. */
function createUpdateEverythingDialog({ ipcMain, WebContentsView, session, themeMode = () => "dark", now = Date.now }) {
	let open = null; // { contents, plan, finish, shownAt }
	ipcMain.handle(CHANNEL, (event, action, ...extra) => {
		const dialog = open;
		const frame = event.senderFrame;
		if (!dialog || dialog.contents.isDestroyed() || event.sender !== dialog.contents || frame !== dialog.contents.mainFrame ||
			typeof frame?.url !== "string" || frame.url.includes("#") || frame.url.split("?")[0] !== PAGE_URL ||
			typeof action !== "string" || !ACTIONS.has(action) || extra.length > 0) {
			throw new Error("Untrusted dialog request.");
		}
		if (action === "plan") {
			dialog.shownAt ??= now();
			return dialog.plan;
		}
		// Too early to be the user's answer to this dialog: ignored, it stays open.
		if (action === "update" && (dialog.shownAt === null || now() - dialog.shownAt < UPDATE_ARM_MS)) return;
		dialog.finish(action === "update");
	});

	/** Shows `plan` over `win` until the user answers: { update, keyboard }, `update` true only for
	 *  Update and `keyboard` when a key press, not a click, closed it. One at a time; a window that
	 *  closes, or a view that goes away, answers no. */
	function ask(win, plan) {
		if (open || !win || win.isDestroyed()) return Promise.resolve({ update: false, keyboard: false });
		return new Promise((resolve) => {
			const view = new WebContentsView({
				webPreferences: {
					session: session.fromPartition(PARTITION, { cache: false }),
					preload: path.join(__dirname, "update-everything-dialog-preload.cjs"),
					sandbox: true, contextIsolation: true, nodeIntegration: false,
				},
			});
			const contents = view.webContents;
			contents.on("will-navigate", (event) => event.preventDefault());
			contents.setWindowOpenHandler(() => ({ action: "deny" }));
			contents.on("will-attach-webview", (event) => event.preventDefault());
			// What the user last pressed in the dialog, a key or the pointer: main's own record.
			let byKey = false;
			contents.on("input-event", (_event, input) => {
				if (input.type === "rawKeyDown" || input.type === "keyDown") byKey = true;
				else if (input.type === "mouseDown" || input.type === "touchStart" || input.type === "gestureTapDown") byKey = false;
			});
			// Clear behind the dialog's own dim backdrop: the page shows through it.
			view.setBackgroundColor("#00000000");
			const fit = () => {
				if (win.isDestroyed()) return;
				const { width, height } = win.contentView.getBounds();
				view.setBounds({ x: 0, y: 0, width, height });
			};
			fit();
			win.contentView.on("bounds-changed", fit);
			win.contentView.addChildView(view);
			// While main asks, the server's page takes no keys, and window focus comes back here.
			const block = (event) => event.preventDefault();
			const focus = () => { if (!contents.isDestroyed()) contents.focus(); };
			win.webContents.on("before-input-event", block);
			win.on("focus", focus);
			let done = false;
			const finish = (answer) => {
				if (done) return;
				done = true;
				if (open?.contents === contents) open = null;
				win.off("focus", focus);
				win.off("closed", closed);
				if (!win.isDestroyed()) {
					win.contentView.off("bounds-changed", fit);
					win.webContents.off("before-input-event", block);
					win.contentView.removeChildView(view);
					win.webContents.focus();
				}
				if (!contents.isDestroyed()) contents.close();
				resolve({ update: answer, keyboard: answered && byKey });
			};
			let answered = false;
			const closed = () => finish(false);
			win.once("closed", closed);
			contents.once("destroyed", () => finish(false));
			contents.once("render-process-gone", () => finish(false));
			open = { contents, plan, finish: (answer) => { answered = true; finish(answer); }, shownAt: null };
			void contents.loadFile(PAGE, { query: { mode: themeMode() === "light" ? "light" : "dark" } }).then(focus, () => finish(false));
		});
	}

	return { ask, isOpen: () => open !== null };
}

module.exports = { createUpdateEverythingDialog, CHANNEL, PAGE, PARTITION, UPDATE_ARM_MS };
