"use strict";

const { randomUUID } = require("node:crypto");
const { atOrigin, isRemotePage, allowsRemoteRedirect, rewritesToPairPage, remoteHeaders } = require("./remote-server.cjs");

function createRemoteWindow({ BrowserWindow, session, origin, token, onProblem }) {
	const isolated = session.fromPartition(`remote-server-${randomUUID()}`, { cache: false });
	const win = new BrowserWindow({
		width: 1440, height: 900, minWidth: 640, minHeight: 600,
		show: false, title: "LearnHarness", autoHideMenuBar: true,
		webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false },
	});
	const contents = win.webContents;
	const id = contents.id;
	const requests = isolated.webRequest;
	const filter = { urls: ["<all_urls>"] };
	const belongs = (details) => details.webContentsId === id && !win.isDestroyed();

	isolated.setPermissionRequestHandler((wc, permission, respond, details) => {
		respond(wc === contents && details.isMainFrame && atOrigin(details.requestingUrl, origin) && permission === "clipboard-sanitized-write");
	});
	isolated.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => (
		wc === contents && details.isMainFrame && requestingOrigin === origin && permission === "clipboard-sanitized-write"
	));
	requests.onBeforeSendHeaders(filter, (details, respond) => {
		if (details.resourceType === "mainFrame" && (!belongs(details) || !isRemotePage(details.url, origin))) return respond({ cancel: true });
		respond({ requestHeaders: remoteHeaders(details, origin, token, win) });
	});
	requests.onHeadersReceived(filter, (details, respond) => {
		if (!belongs(details) || !atOrigin(details.url, origin)) return respond({});
		const mainFrame = details.resourceType === "mainFrame";
		if (!allowsRemoteRedirect(details, origin)) {
			respond({ cancel: true });
			if (mainFrame) onProblem(true);
			return;
		}
		const pairRewrite = rewritesToPairPage(details);
		if (pairRewrite || (mainFrame && details.statusCode >= 400) || details.statusCode === 401 || details.statusCode === 426) {
			respond(mainFrame || pairRewrite ? { cancel: true } : {});
			onProblem(mainFrame);
			return;
		}
		respond({});
	});
	contents.on("will-navigate", (event, target) => {
		if (!isRemotePage(target, origin)) event.preventDefault();
	});
	contents.setWindowOpenHandler(() => ({ action: "deny" }));
	contents.on("will-attach-webview", (event) => event.preventDefault());
	contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
		if (code !== -3 && mainFrame && !win.isDestroyed()) onProblem(true);
	});
	win.once("closed", () => {
		requests.onBeforeSendHeaders(null);
		requests.onHeadersReceived(null);
		void isolated.closeAllConnections().catch(() => {});
	});
	return win;
}

module.exports = { createRemoteWindow };
