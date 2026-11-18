"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { openServerList } = require("./server-list-store.cjs");
const { ServerProblem, parseOrigin, withScheme, normalizeCode, parsePairLink, checkDescriptor, checkSession, pairServer } = require("./remote-server.cjs");
const { remoteChatGPTSignIn } = require("./remote-chatgpt.cjs");
const { createRemoteWindow } = require("./remote-window.cjs");
const { BACKGROUND, hostLabel, paintFirst, showGhost, coverWindow } = require("./skeleton.cjs");
const { trace, traceWindow } = require("./first-frame.cjs");

const SHELL = path.join(__dirname, "server-list.html");
const CHANNEL = "lh:server-list";
const CHANGED = "lh:server-list:changed";
// The shell carries only the theme mode in its query.
function isShell(value) {
	try {
		const url = new URL(value);
		return url.protocol === "file:" && url.pathname === pathToFileURL(SHELL).pathname && !url.hash;
	} catch { return false; }
}

async function createServerList({
	app, BrowserWindow, WebContentsView, ipcMain, session, shell, safeStorage,
	startLocal, stopLocal, createLocalWindow, setLocalMenu, themeMode = () => "dark", platform = process.platform,
}) {
	const file = path.join(app.getPath("userData"), "servers.json");
	const store = await openServerList(file, safeStorage);

	let active = null;
	let window = null;
	let controls = null;
	let busy = false;
	let problem = null;
	let notice = "";
	let connecting = null;
	// A ghost-dashboard connect is in flight: launch and reopen wait on it.
	let ghosting = false;
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
				width: 530, height: 590, minWidth: 390, minHeight: 420, title: "LearnHarness",
				autoHideMenuBar: true, backgroundColor: BACKGROUND[themeMode()] ?? BACKGROUND.dark,
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
			void panel.loadFile(SHELL, { query: { mode: themeMode() === "light" ? "light" : "dark" } });
		} else {
			if (controls.isMinimized()) controls.restore();
			controls.focus();
		}
		return controls;
	}
	function closeList() {
		const panel = controls;
		controls = null;
		if (panel && !panel.isDestroyed()) {
			trace("list closed");
			panel.destroy();
		}
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
	// Launch, Dock reopen and "This computer" open the app window at once with
	// the ghost dashboard. Other connects keep "Connecting…" in the list.
	async function connect(server, code, { quiet = false } = {}) {
		if (busy || closing) return;
		busy = true;
		problem = null;
		notice = "";
		const ghost = quiet || server === "local";
		ghosting = ghost;
		if (!ghost) show();
		publish();
		const operation = new AbortController();
		connecting = operation;
		const options = { signal: operation.signal, retry: true };
		// Closing the ghost dashboard cancels the connect quietly.
		const hold = (win) => win.once("closed", () => { if (connecting === operation) operation.abort(); });
		// The window shows only after its own page has painted the skeleton.
		// The overlay then keeps covering it while the real page loads below.
		async function ghostWindow(win, status, frame) {
			hold(win);
			traceWindow(win, server === "local" ? "local" : "remote");
			await paintFirst(win, { mode: themeMode(), status, frame });
			operation.signal.throwIfAborted();
			// macOS and Linux show synchronously, exactly as before.
			const fade = platform === "win32";
			const shown = showGhost(win, { fade });
			if (fade) {
				await shown;
				operation.signal.throwIfAborted();
			}
			const skeleton = coverWindow(win, { WebContentsView, session, mode: themeMode(), status, frame });
			skeleton.focus();
			return skeleton;
		}
		// Stops waiting when the connect is cancelled, and fails when the
		// overlay went away before it painted.
		async function beforeLoad(skeleton) {
			const cancelled = new Promise((resolve) => operation.signal.addEventListener("abort", () => resolve(false), { once: true }));
			const painted = await Promise.race([skeleton.painted, cancelled]);
			operation.signal.throwIfAborted();
			if (!painted) throw new Error("The ghost dashboard didn’t paint.");
		}
		try {
			const previous = active?.server;
			destroyContent();
			setLocalMenu(false);
			if (previous === "local" && server !== "local") await stopLocal();
			if (server === "local") {
				// The bundled server starts while the ghost dashboard paints.
				const starting = startLocal(operation.signal);
				starting.catch(() => {});
				const local = createLocalWindow();
				registerContent(local.win);
				const skeleton = await ghostWindow(local.win, "Starting LearnHarness…", platform === "darwin" ? "inset" : "hidden");
				// An open list closes only once the shown window has painted.
				await beforeLoad(skeleton);
				closeList();
				const url = await starting;
				operation.signal.throwIfAborted();
				if (!store.damaged && !store.defaultServer) await store.saveDefault(server);
				// As before, the bundled app's own load errors stay in its window.
				trace("real page load start", "local");
				await local.load(url).catch(() => {});
				operation.signal.throwIfAborted();
				active = { server };
				setLocalMenu(true);
				trace("reveal", "local");
				skeleton.reveal();
				local.win.focus();
				local.win.webContents.focus();
			} else {
				// A saved bearer is read before the window exists, so the
				// skeleton can show while the checks wait on the server.
				let token = code ? null : await store.readToken(server);
				let win;
				let skeleton;
				const open = () => {
					const selection = { server, token };
					const lifetime = new AbortController();
					const created = createRemoteWindow({
						BrowserWindow, session, origin: server, token, signal: lifetime.signal,
						backgroundColor: BACKGROUND[themeMode()] ?? BACKGROUND.dark,
						openExternal: (target) => shell.openExternal(target),
						onProblem: (mainFrame) => { void recheck(created, selection, mainFrame, lifetime.signal); },
					});
					created.once("closed", () => lifetime.abort());
					registerContent(created);
					return created;
				};
				if (quiet) {
					win = open();
					skeleton = await ghostWindow(win, `Connecting to ${hostLabel(server)}…`);
				}
				await checkDescriptor(server, options);
				if (code) {
					await store.requireEncryption();
					token = await pairServer(server, code, options);
					await store.savePairing(server, token);
				}
				await checkSession(server, token, options);
				win ??= open();
				if (skeleton) await beforeLoad(skeleton);
				try {
					trace("real page load start", "remote");
					await win.loadURL(server).catch((error) => {
						if (error.code !== "ERR_HTTP_RESPONSE_CODE_FAILURE") throw error;
					});
					// Older protocol-compatible servers may still rewrite a
					// late revocation to /pair. Keep the first load unseen,
					// hidden or under the skeleton, until this check passes.
					await checkSession(server, token, options);
					operation.signal.throwIfAborted();
					if (!store.defaultServer) await store.saveDefault(server);
					operation.signal.throwIfAborted();
					active = { server, token };
					trace(skeleton ? "reveal" : "show() call", skeleton ? "remote" : "list connect");
					if (skeleton) skeleton.reveal();
					else win.show();
					win.focus();
					win.webContents.focus();
				} catch (error) {
					// This reclassification still doesn't retry, as before.
					if (!operation.signal.aborted && !(error instanceof ServerProblem)) await checkSession(server, token, { signal: operation.signal });
					throw error;
				}
			}
			closeList();
			return window;
		} catch (error) {
			if (server === "local") await stopLocal();
			// Show the list before closing the window, so the app never
			// runs out of windows on the way to the problem.
			if (!operation.signal.aborted) fail(server, error);
			destroyContent();
		} finally {
			connecting = null;
			ghosting = false;
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
			event.senderFrame !== controls.webContents.mainFrame || !isShell(event.senderFrame.url)) {
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
			const origin = parseOrigin(withScheme(value?.origin));
			if (!origin) return "Enter the HTTPS address of your server, or paste its pairing link.";
			const code = normalizeCode(value?.code);
			if (!code) return "Enter the 12-character pairing code.";
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
			if (ghosting) return this.reopen();
			if (store.defaultServer) return connect(store.defaultServer, undefined, { quiet: true });
			show();
		},
		reopen() {
			if (ghosting) {
				// Its window may not exist yet while the saved credential is read.
				if (window && !window.isDestroyed()) window.focus();
				return window;
			}
			if (active) return connect(active.server, undefined, { quiet: true });
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
