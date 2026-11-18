"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { enabled: tracing, trace } = require("./first-frame.cjs");

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
		timer = setTimeout(() => { trace("paintFirst fallback fired (1 s, no ready-to-show)"); resolve(); }, 1000);
	});
	trace("paintFirst own page load start");
	await win.loadFile(PAGE, { query: pageQuery(options) }).catch((error) => trace("paintFirst own page load failed", error.code));
	await painted;
	clearTimeout(timer);
	trace("paintFirst done");
}

// Windows puts a newly shown window on screen before Chromium has drawn
// into it. The window shows transparent until its page has produced a
// frame while visible, or until this fallback.
const firstFrame = { fallbackMs: 500 };

/** Show a ghost window. Only Windows (`fade`) adds the opacity step;
 *  macOS and Linux show it directly. */
async function showGhost(win, { fade }) {
	if (!fade) {
		trace("show() call", "ghostWindow");
		win.show();
		tracePaint(win.webContents, "own page after show");
		return;
	}
	trace("setOpacity(0)");
	win.setOpacity(0);
	trace("show() call", "ghostWindow");
	win.show();
	let timer;
	const framed = await Promise.race([
		win.webContents.executeJavaScript(PAINTED).then(() => true, () => false),
		new Promise((resolve) => { timer = setTimeout(() => resolve(null), firstFrame.fallbackMs); }),
	]);
	clearTimeout(timer);
	trace(framed === null ? `opacity fallback fired (${firstFrame.fallbackMs} ms)` : framed ? "frame produced while transparent" : "frame wait failed");
	if (win.isDestroyed()) return;
	win.setOpacity(1);
	trace("setOpacity(1)");
}

/** Diagnostics only: when a page produces a frame. */
function tracePaint(contents, name) {
	if (!tracing) return;
	contents.executeJavaScript(PAINTED).then(() => trace("frame produced", name), () => trace("frame wait failed", name));
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
	trace("overlay attached");
	// Until the reveal, the unseen page takes no keys, and window focus goes
	// back to the skeleton. The skeleton covers it for every mouse event.
	const block = (event) => event.preventDefault();
	const focus = () => { if (!contents.isDestroyed()) contents.focus(); };
	win.webContents.on("before-input-event", block);
	win.on("focus", focus);
	let removed = false;
	// Settles "not painted" when the overlay goes away first, so a window
	// closed or never shown before its first frame can't leave a wait open.
	let gone;
	const goneFirst = new Promise((resolve) => { gone = () => resolve(false); });
	contents.once("destroyed", gone);
	// The real page may load underneath only after this resolves true: from
	// then on the view is opaque, even if its frame is later dropped.
	const painted = Promise.race([goneFirst, contents.loadFile(PAGE, { query: pageQuery({ mode, status, frame }) })
		.then(() => { trace("overlay did-finish-load"); return contents.executeJavaScript(PAINTED); })
		.then(() => {
			if (removed || contents.isDestroyed()) return false;
			view.setBackgroundColor(BACKGROUND[mode] ?? BACKGROUND.dark);
			return true;
		}, () => false)]);
	void painted.then((value) => trace(value ? "overlay painted" : "overlay not painted"));
	function remove() {
		if (removed) return;
		removed = true;
		gone();
		trace("overlay removed");
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

module.exports = { PAGE, BACKGROUND, firstFrame, hostLabel, isSkeletonPage, paintFirst, showGhost, coverWindow };
