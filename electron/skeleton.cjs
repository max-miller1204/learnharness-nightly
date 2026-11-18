"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PAGE = path.join(__dirname, "skeleton.html");
// The Default theme's page and the app's original light default.
const BACKGROUND = { dark: "#141414", light: "#f5f5f3" };

/** The first label of a server name, or a whole IP literal. */
function hostLabel(origin) {
	const host = new URL(origin).hostname;
	if (host.startsWith("[")) return host.slice(1, -1);
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
	return host.split(".")[0];
}

/** Lay the ghost dashboard over a window's own page. The page below loads
 *  unseen in its own WebContents; the skeleton is a separate local page with
 *  a throwaway session, no preload and no network (strict CSP). */
function coverWindow(win, { WebContentsView, session, mode, status, frame }) {
	const view = new WebContentsView({
		webPreferences: {
			session: session.fromPartition(`skeleton-${randomUUID()}`, { cache: false }),
			sandbox: true, contextIsolation: true, nodeIntegration: false,
		},
	});
	const contents = view.webContents;
	contents.on("will-navigate", (event) => event.preventDefault());
	contents.setWindowOpenHandler(() => ({ action: "deny" }));
	contents.on("will-attach-webview", (event) => event.preventDefault());
	view.setBackgroundColor(BACKGROUND[mode] ?? BACKGROUND.dark);
	const fit = () => {
		if (win.isDestroyed()) return;
		const [width, height] = win.getContentSize();
		view.setBounds({ x: 0, y: 0, width, height });
	};
	fit();
	win.on("resize", fit);
	win.contentView.addChildView(view);
	// frame: "inset" (macOS traffic lights) or "hidden" for the frameless
	// local window, whose top band drags it. Remote windows keep a frame.
	const query = { mode: mode === "light" ? "light" : "dark", status, ...(frame && { frame }) };
	void contents.loadFile(PAGE, { query }).catch(() => {});
	let removed = false;
	function remove() {
		if (removed) return;
		removed = true;
		win.off("resize", fit);
		if (!win.isDestroyed()) win.contentView.removeChildView(view);
		if (!contents.isDestroyed()) contents.close();
	}
	win.once("closed", remove);
	// While it covers the page, keys go to the skeleton, not the unseen page.
	return { reveal: remove, focus: () => { if (!contents.isDestroyed()) contents.focus(); } };
}

module.exports = { BACKGROUND, hostLabel, coverWindow };
