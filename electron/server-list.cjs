"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { openServerList } = require("./server-list-store.cjs");
const { ServerProblem, parseOrigin, normalizeCode, parsePairLink, checkDescriptor, checkSession, pairServer } = require("./remote-server.cjs");
const { remoteChatGPTSignIn } = require("./remote-chatgpt.cjs");
const { createRemoteWindow } = require("./remote-window.cjs");

const SHELL = path.join(__dirname, "server-list.html");
const CHANNEL = "lh:server-list";
const CHANGED = "lh:server-list:changed";

async function createServerList({ app, BrowserWindow, ipcMain, session, shell, safeStorage, startLocal, stopLocal, createLocalWindow, setLocalMenu }) {
	const file = path.join(app.getPath("userData"), "servers.json");
	const store = await openServerList(file, safeStorage);

	let active = null;
	let window = null;
	let controls = null;
	let busy = false;
	let problem = null;
	let notice = "";
	let connecting = null;
	let login = null;
	// Settles after the latest attempt, including any cancel it sends.
	let lastLogin = Promise.resolve();
	const rechecking = new WeakSet();
	let closing = false;

	function snapshot() {
		return {
			servers: store.origins, defaultServer: store.defaultServer, damaged: store.damaged,
			active: window ? active?.server ?? null : null, busy, problem,
			notice: notice || (store.damaged ? "Couldn’t read the saved server list." : ""), signingIn: !!login,
		};
	}
	function publish() {
		if (controls && !controls.isDestroyed()) controls.webContents.send(CHANGED, snapshot());
	}
	function show() {
		if (!controls || controls.isDestroyed()) {
			const panel = new BrowserWindow({
				width: 530, height: 590, minWidth: 390, minHeight: 420, title: "LearnHarness servers",
				autoHideMenuBar: true,
				webPreferences: {
					session: session.fromPartition(`server-list-${randomUUID()}`),
					sandbox: true, contextIsolation: true, nodeIntegration: false,
					preload: path.join(__dirname, "server-list-preload.cjs"),
				},
			});
			controls = panel;
			panel.webContents.on("will-navigate", (event) => event.preventDefault());
			panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
			panel.webContents.on("will-attach-webview", (event) => event.preventDefault());
			panel.once("closed", () => { if (controls === panel) controls = null; });
			void panel.loadFile(SHELL);
		} else {
			if (controls.isMinimized()) controls.restore();
			controls.focus();
		}
		return controls;
	}
	function destroyContent() {
		login?.abort();
		login = null;
		active = null;
		if (window && !window.isDestroyed()) window.destroy();
		window = null;
	}
	function registerContent(win) {
		window = win;
		win.once("closed", () => {
			if (window === win) {
				window = null;
				login?.abort();
				login = null;
				publish();
			}
		});
	}
	function fail(server, error) {
		problem = {
			server,
			kind: error instanceof ServerProblem ? error.kind : "retry",
			message: error instanceof ServerProblem ? error.message : "Couldn’t open this LearnHarness server. Try again.",
		};
		show();
		publish();
	}
	async function recheck(win, selection, mainFrame, signal) {
		if (rechecking.has(win) || busy || win !== window) return;
		rechecking.add(win);
		try {
			await checkDescriptor(selection.server, { signal });
			await checkSession(selection.server, selection.token, { signal });
			if (mainFrame) throw new ServerProblem("retry", "Couldn’t load the server page. Try again.");
		} catch (error) {
			if (win === window && !busy) {
				fail(selection.server, error);
				destroyContent();
				publish();
			}
		} finally { rechecking.delete(win); }
	}
	async function connect(server, code) {
		if (busy || closing) return;
		busy = true;
		problem = null;
		notice = "";
		show();
		publish();
		const operation = new AbortController();
		connecting = operation;
		const options = { signal: operation.signal };
		try {
			const previous = active?.server;
			destroyContent();
			setLocalMenu(false);
			if (previous === "local" && server !== "local") await stopLocal();
			if (server === "local") {
				const url = await startLocal(operation.signal);
				operation.signal.throwIfAborted();
				if (!store.damaged && !store.defaultServer) await store.saveDefault(server);
				operation.signal.throwIfAborted();
				active = { server };
				registerContent(createLocalWindow(url));
				setLocalMenu(true);
			} else {
				await checkDescriptor(server, options);
				let token;
				if (code) {
					await store.requireEncryption();
					token = await pairServer(server, code, options);
					await store.savePairing(server, token);
				} else {
					token = await store.readToken(server);
				}
				await checkSession(server, token, options);
				const selection = { server, token };
				const lifetime = new AbortController();
				const win = createRemoteWindow({
					BrowserWindow, session, origin: server, token, signal: lifetime.signal,
					openExternal: (target) => shell.openExternal(target),
					onProblem: (mainFrame) => { void recheck(win, selection, mainFrame, lifetime.signal); },
				});
				win.once("closed", () => lifetime.abort());
				registerContent(win);
				try {
					await win.loadURL(server).catch((error) => {
						if (error.code !== "ERR_HTTP_RESPONSE_CODE_FAILURE") throw error;
					});
					// Older protocol-compatible servers may still rewrite a
					// late revocation to /pair. Keep the first load hidden.
					await checkSession(server, token, options);
					operation.signal.throwIfAborted();
					if (!store.defaultServer) await store.saveDefault(server);
					operation.signal.throwIfAborted();
					active = selection;
					win.show();
					win.focus();
				} catch (error) {
					if (win === window) destroyContent();
					if (!(error instanceof ServerProblem)) await checkSession(server, token, options);
					throw error;
				}
			}
			const panel = controls;
			controls = null;
			if (panel && !panel.isDestroyed()) panel.destroy();
			return window;
		} catch (error) {
			if (server === "local") await stopLocal();
			if (!closing) fail(server, error);
		} finally {
			connecting = null;
			busy = false;
			publish();
		}
	}
	async function signIn() {
		if (busy || login || !active?.token || !window) return;
		const selection = active;
		const operation = new AbortController();
		login = operation;
		notice = "";
		publish();
		const previous = lastLogin;
		let settled;
		lastLogin = new Promise((resolve) => { settled = resolve; });
		try {
			// An abandoned attempt may still be cancelling on its server.
			await previous;
			operation.signal.throwIfAborted();
			await remoteChatGPTSignIn(selection.server, selection.token, {
				signal: operation.signal, openExternal: (url) => shell.openExternal(url),
			});
			notice = "ChatGPT sign-in completed.";
		} catch (error) {
			if (!operation.signal.aborted) notice = error instanceof ServerProblem ? error.message : "ChatGPT sign-in failed. Try again from Switch server.";
		} finally {
			settled();
			if (login === operation) {
				login = null;
				publish();
			}
		}
	}
	ipcMain.handle(CHANNEL, async (event, action, value) => {
		if (!controls || controls.isDestroyed() || event.sender !== controls.webContents ||
			event.senderFrame !== controls.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(SHELL).href) {
			throw new Error("Untrusted server window request.");
		}
		if (action === "state") return snapshot();
		if (action === "link") return typeof value === "string" && value.length <= 8192 ? parsePairLink(value) : null;
		if (busy || closing) return;
		if (action === "connect" && (value === "local" || store.origins.includes(value))) return connect(value);
		if (action === "reset" && store.damaged) {
			busy = true;
			try {
				await store.reset();
				notice = "";
			} catch { notice = "Couldn’t reset the saved server list."; }
			finally { busy = false; publish(); }
		} else if (action === "pair" && !store.damaged) {
			const origin = parseOrigin(value?.origin);
			const code = normalizeCode(value?.code);
			if (!origin || !code) return "Enter an HTTPS origin and a 12-character pairing code.";
			await connect(origin, code);
		} else if (action === "default" && !store.damaged && active?.server === value && store.defaultServer !== value) {
			busy = true;
			publish();
			try { await store.saveDefault(value); }
			catch { notice = "Couldn’t save the launch default."; }
			finally { busy = false; publish(); }
		} else if (action === "sign-in") {
			void signIn();
		}
	});
	return {
		show,
		async launch() {
			show();
			if (store.defaultServer) return connect(store.defaultServer);
		},
		reopen() {
			if (active) return connect(active.server);
			if (problem || busy) return show();
			return this.launch();
		},
		close() {
			closing = true;
			connecting?.abort();
			login?.abort();
		},
	};
}

module.exports = { createServerList };
