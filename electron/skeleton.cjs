"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const PAGE = path.join(__dirname, "skeleton.html");
// The Default theme's page and the app's original light default.
const BACKGROUND = { dark: "#141414", light: "#f5f5f3" };
// Resolves once the page has produced a frame.
const PAINTED = "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))";

function pageQuery({ mode, status, frame }) {
	// frame: "inset" (macOS traffic lights) or "hidden" for the frameless
	// local window, whose top band drags it. Remote windows keep a frame.
	return { mode: mode === "light" ? "light" : "dark", status, ...(frame && { frame }) };
}

function isSkeletonPage(value) {
	try {
		const url = new URL(value);
		return url.protocol === "file:" && url.pathname === pathToFileURL(PAGE).pathname && !url.hash;
	} catch { return false; }
}

/** A child view paints only once its window shows, so the hidden window's
 *  own page paints the skeleton first. Resolves after that first paint,
 *  so the window's first visible frame is already the skeleton. */
async function paintFirst(win, options) {
	let timer;
	const painted = new Promise((resolve) => {
		win.once("ready-to-show", resolve);
		timer = setTimeout(resolve, 1000);
	});
	await win.loadFile(PAGE, { query: pageQuery(options) }).catch(() => {});
	await painted;
	clearTimeout(timer);
}

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
	// Clear until it paints, so the window's own skeleton shows through.
	view.setBackgroundColor("#00000000");
	// The content view's bounds follow every content-area change, including
	// the Alt menu bar on Windows and Linux, which fires no window resize.
	const fit = () => {
		if (win.isDestroyed()) return;
		const { width, height } = win.contentView.getBounds();
		view.setBounds({ x: 0, y: 0, width, height });
	};
	fit();
	win.contentView.on("bounds-changed", fit);
	win.contentView.addChildView(view);
	// Until the reveal, the unseen page takes no keys, and window focus goes
	// back to the skeleton. The skeleton covers it for every mouse event.
	const block = (event) => event.preventDefault();
	const focus = () => { if (!contents.isDestroyed()) contents.focus(); };
	win.webContents.on("before-input-event", block);
	win.on("focus", focus);
	let removed = false;
	// The real page may load underneath only after this resolves true: from
	// then on the view is opaque, even if its frame is later dropped.
	const painted = contents.loadFile(PAGE, { query: pageQuery({ mode, status, frame }) })
		.then(() => contents.executeJavaScript(PAINTED))
		.then(() => {
			if (removed || contents.isDestroyed()) return false;
			view.setBackgroundColor(BACKGROUND[mode] ?? BACKGROUND.dark);
			return true;
		}, () => false);
	function remove() {
		if (removed) return;
		removed = true;
		win.off("focus", focus);
		if (!win.isDestroyed()) {
			win.contentView.off("bounds-changed", fit);
			win.webContents.off("before-input-event", block);
			win.contentView.removeChildView(view);
		}
		if (!contents.isDestroyed()) contents.close();
	}
	win.once("closed", remove);
	return { reveal: remove, focus, painted };
}

module.exports = { PAGE, BACKGROUND, hostLabel, isSkeletonPage, paintFirst, coverWindow };
