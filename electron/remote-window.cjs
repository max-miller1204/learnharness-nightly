"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { atOrigin, isRemotePage, allowsRemoteRedirect, redirectLocation, rewritesToPairPage, remoteHeaders } = require("./remote-server.cjs");

const { isBrowserAction, openWebSubscriptionBrowser } = require("./web-subscription-browser.cjs");
const { isSkeletonPage } = require("./skeleton.cjs");
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function createRemoteWindow({ BrowserWindow, session, origin, token, signal, backgroundColor, openExternal, onProblem }) {
	const isolated = session.fromPartition(`remote-server-${randomUUID()}`, { cache: false });
	const win = new BrowserWindow({
		width: 1440, height: 900, minWidth: 640, minHeight: 600,
		show: false, title: "LearnHarness", autoHideMenuBar: true, ...(backgroundColor && { backgroundColor }),
		// remote-preload.cjs exposes only window.lh.desktopUpdate and window.lh.chatgptSignIn.
		webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "remote-preload.cjs") },
	});
	const contents = win.webContents;
	const id = contents.id;
	const requests = isolated.webRequest;
	const filter = { urls: ["<all_urls>"] };
	const belongs = (details) => details.webContentsId === id && !win.isDestroyed();
	let popup;
	// The ghost dashboard paints in this window's own page before anything
	// from the server loads. Only that one local page, and only until then.
	let remoteLoaded = false;

	async function openInBrowser(target) {
		const url = new URL(target);
		if (signal?.aborted || win.isDestroyed() || !EXTERNAL_SCHEMES.has(url.protocol) ||
			url.username || url.password || decodeURIComponent(url.href).includes(token)) return;
		await openExternal(url.href);
	}
	async function handoff(target) {
		const url = new URL(target);
		const action = url.pathname + url.search;
		if (atOrigin(url, origin) && isBrowserAction(action) && !url.hash) {
			return openWebSubscriptionBrowser(action, origin, {
				token, signal,
				openExternal: async (destination) => {
					if (!atOrigin(destination, origin)) await openInBrowser(destination);
				},
			});
		}
		return openInBrowser(url);
	}
	function finishPopup(target) {
		const pending = popup;
		popup = null;
		pending.destroy();
		void handoff(target).catch(() => {});
	}

	isolated.setPermissionRequestHandler((wc, permission, respond, details) => {
		respond(wc === contents && details.isMainFrame && atOrigin(details.requestingUrl, origin) && permission === "clipboard-sanitized-write");
	});
	isolated.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => (
		wc === contents && details.isMainFrame && requestingOrigin === origin && permission === "clipboard-sanitized-write"
	));
	requests.onBeforeSendHeaders(filter, (details, respond) => {
		if (popup && details.webContentsId === popup.webContents.id) {
			respond({ cancel: true });
			if (details.resourceType === "mainFrame" && details.method === "GET") finishPopup(details.url);
			return;
		}
		if (details.resourceType === "mainFrame" && !remoteLoaded && belongs(details) && isSkeletonPage(details.url)) return respond({});
		if (details.resourceType === "mainFrame" && (!belongs(details) || !isRemotePage(details.url, origin))) return respond({ cancel: true });
		if (details.resourceType === "mainFrame") remoteLoaded = true;
		respond({ requestHeaders: remoteHeaders(details, origin, token, win) });
	});
	requests.onHeadersReceived(filter, (details, respond) => {
		if (!belongs(details) || !atOrigin(details.url, origin)) return respond({});
		const mainFrame = details.resourceType === "mainFrame";
		if (!allowsRemoteRedirect(details, origin)) {
			let target;
			try { target = new URL(redirectLocation(details), details.url); } catch { /* Cancel below. */ }
			if (mainFrame && target && !atOrigin(target, origin)) {
				// Cancelling here would replace the page with a Chromium error.
				// will-redirect stops this navigation and keeps the current page.
				respond({});
				if (details.method === "GET") void openInBrowser(target).catch(() => {});
				return;
			}
			respond({ cancel: true });
			if (mainFrame && target) onProblem(true);
			return;
		}
		const pairRewrite = rewritesToPairPage(details);
		if (pairRewrite || details.statusCode === 401 || details.statusCode === 426 ||
			(mainFrame && (details.statusCode === 403 || details.statusCode >= 500))) {
			respond(pairRewrite ? { cancel: true } : {});
			onProblem(mainFrame && pairRewrite);
			return;
		}
		respond({});
	});
	contents.on("will-navigate", (event, target) => {
		if (isRemotePage(target, origin)) return;
		event.preventDefault();
		if (!atOrigin(target, origin)) void openInBrowser(target).catch(() => {});
	});
	contents.on("will-redirect", (event) => {
		// The redirected request is also refused in onBeforeSendHeaders.
		if (event.isMainFrame && !isRemotePage(event.url, origin)) event.preventDefault();
	});
	contents.setWindowOpenHandler(({ url, postBody }) => {
		// The web subscription client reserves about:blank synchronously.
		// It gets a window handle, but no URL is ever loaded in the popup.
		if (url === "about:blank" && !popup) return { action: "allow", overrideBrowserWindowOptions: { show: false } };
		if (!postBody && url !== "about:blank") void handoff(url).catch(() => {});
		return { action: "deny" };
	});
	contents.on("did-create-window", (created) => {
		popup = created;
		created.once("closed", () => { if (popup === created) popup = null; });
		created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		created.webContents.on("will-frame-navigate", (event) => {
			event.preventDefault();
			if (popup === created && event.isMainFrame) finishPopup(event.url);
		});
	});
	contents.on("will-attach-webview", (event) => event.preventDefault());
	contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
		// Chromium also reports an empty HTTP error response as a load
		// failure. It is still a page response, unlike a network failure.
		if (code !== -3 && code !== -379 && mainFrame && !win.isDestroyed()) onProblem(false);
	});
	win.once("closed", () => {
		if (popup && !popup.isDestroyed()) popup.destroy();
		requests.onBeforeSendHeaders(null);
		requests.onHeadersReceived(null);
		void isolated.closeAllConnections().catch(() => {});
	});
	return win;
}

module.exports = { createRemoteWindow };
