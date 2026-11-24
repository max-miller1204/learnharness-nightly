"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { openServerList } = require("./server-list-store.cjs");
const { ServerProblem, atOrigin, parseOrigin, withScheme, normalizeCode, parsePairLink, checkDescriptor, checkSession, pairServer } = require("./remote-server.cjs");
const { createRemoteChatGPTSignIn } = require("./remote-chatgpt.cjs");
const { createRemoteWindow } = require("./remote-window.cjs");
const { BACKGROUND, hostLabel, paintFirst, tracePaint, opaqueWhenPainted, coverWindow } = require("./skeleton.cjs");
const { trace, traceWindow } = require("./first-frame.cjs");

const SHELL = path.join(__dirname, "server-list.html");
// The page's own once-per-version automatic reload (components/sidebar-update-pill.tsx, #264):
// sessionStorage key and how many versions it keeps. Later claims the version it reloads for.
const AUTO_RELOAD_KEY = "lh-auto-reloaded-versions";
const AUTO_RELOAD_MEMORY = 50;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[a-z]+\.\d{8}\.\d+)?$/;

/** Run in the server's page: mark `version` as already reloaded for, as claimAutoReload does. */
function claimReloadScript(version) {
	return `(() => { try {
		const key = ${JSON.stringify(AUTO_RELOAD_KEY)}, version = ${JSON.stringify(version)};
		let seen; try { seen = JSON.parse(sessionStorage.getItem(key) ?? "[]"); } catch { seen = []; }
		const versions = Array.isArray(seen) ? seen.filter((item) => typeof item === "string") : [];
		if (!versions.includes(version)) sessionStorage.setItem(key, JSON.stringify([...versions, version].slice(-${AUTO_RELOAD_MEMORY})));
	} catch {} })()`;
}
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
	app, BrowserWindow, WebContentsView, ipcMain, session, shell, safeStorage, dialog,
	startLocal, stopLocal, createLocalWindow, setLocalMenu, themeMode = () => "dark", platform = process.platform,
	updatingServer = () => null,
	// The remote window's server just became the selected one: its page's bridge answers from now on.
	selected = () => {},
}) {
	const file = path.join(app.getPath("userData"), "servers.json");
	const store = await openServerList(file, safeStorage);

	let active = null;
	let window = null;
	let controls = null;
	let busy = false;
	// The saved server a confirmed Remove is forgetting, while its write runs.
	let removing = null;
	let problem = null;
	let notice = "";
	let connecting = null;
	// A ghost-dashboard connect is in flight: launch and reopen wait on it.
	let ghosting = false;
	// The running check of each window: { server, stop, again }.
	const rechecks = new WeakMap();
	// Each remote window's lifetime: it ends any check still running for it.
	const lifetimes = new WeakMap();
	let closing = false;
	// Update everything (update-everything.cjs) covers the server's page with the
	// ghost dashboard while the server restarts. Its errors then are expected.
	let updating = null;

	// One rule for the races around Remove and Update everything: while a server is being
	// removed or an update is running against it, nothing starts, reconnects or acts for it.
	function held(server) {
		return !!server && (removing === server || updatingServer() === server || updating?.origin === server);
	}
	const HELD_BY_UPDATE = "Update everything is running for this server. Try again once it finishes.";
	const REPAIRED = "This server was paired again, so it wasn’t removed.";
	function snapshot() {
		return {
			servers: store.origins, defaultServer: store.defaultServer, damaged: store.damaged,
			active: window ? active?.server ?? null : null, busy: busy || !!removing, removing: !!removing, problem,
			notice: notice || (store.damaged ? "Couldn’t read the saved server list." : ""),
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
		// A switch away from the covered window ends its cover: rechecks resume for the next one.
		if (updating && updating.win === window) {
			updating.stop();
			updating = null;
		}
		chatgpt.abort();
		active = null;
		if (window && !window.isDestroyed()) window.destroy();
		window = null;
	}
	function registerContent(win) {
		window = win;
		win.once("closed", () => {
			if (window === win) {
				window = null;
				chatgpt.abort();
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
	// `retry`: wait out a restarting server first, as a connect does. A page failure or a
	// Switch server check that arrives while one runs is kept, and runs once that one ends.
	async function recheck(win, selection, mainFrame, signal, { retry = false } = {}) {
		if (updating || busy || win !== window || held(selection.server)) return;
		const running = rechecks.get(win);
		if (running) {
			running.again = { mainFrame: mainFrame || !!running.again?.mainFrame, retry: retry || !!running.again?.retry };
			return;
		}
		const check = { server: selection.server, stop: new AbortController(), again: null };
		rechecks.set(win, check);
		const options = { signal: signal ? AbortSignal.any([signal, check.stop.signal]) : check.stop.signal, retry };
		let failure = null;
		try {
			await checkDescriptor(selection.server, options);
			await checkSession(selection.server, selection.token, options);
			if (mainFrame) throw new ServerProblem("retry", "Couldn’t load the server page. Try again.");
		} catch (error) { failure = error; }
		finally { rechecks.delete(win); }
		if (options.signal.aborted) return;
		if (check.again) {
			return recheck(win, selection, mainFrame || check.again.mainFrame, signal, { retry: retry || check.again.retry });
		}
		if (failure && win === window && !busy && !held(selection.server)) {
			fail(selection.server, failure);
			destroyContent();
			publish();
		}
	}
	// Launch, Dock reopen and "This computer" open the app window at once with
	// the ghost dashboard. Other connects keep "Connecting…" in the list.
	// Only a connect the user starts in the list (not launch or reopen) finishes first setup.
	async function connect(server, code, { quiet = false } = {}) {
		if (busy || closing) return;
		if (held(server)) {
			notice = removing === server ? "" : HELD_BY_UPDATE;
			publish();
			return;
		}
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
			// Windows shows the window transparent until the ghost overlay has
			// painted. macOS and Linux keep the same order without that step.
			const fade = platform === "win32";
			if (fade) {
				trace("setOpacity(0)");
				win.setOpacity(0);
			}
			trace("show() call", "ghostWindow");
			win.show();
			if (!fade) tracePaint(win.webContents, "own page after show");
			const skeleton = coverWindow(win, { WebContentsView, session, mode: themeMode(), status, frame });
			skeleton.focus();
			if (fade) {
				await opaqueWhenPainted(win, skeleton);
				operation.signal.throwIfAborted();
			}
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
				if (!quiet && !store.damaged && store.firstSetup) await store.saveDefault(server);
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
					lifetimes.set(created, lifetime.signal);
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
					if (!quiet && store.firstSetup) await store.saveDefault(server);
					operation.signal.throwIfAborted();
					active = { server, token };
					// A page that mounted during the load had its reads refused (no server was selected
					// yet): hand it the updater's status now, as a later push would.
					try { selected(); } catch { /* the page's next read covers it */ }
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
	// T3's "Remove from this device…" (ConnectionsSettings.tsx): confirm, then forget the
	// pairing. Removing the open server closes its window, as T3 disconnects a removed one.
	async function remove(server) {
		if (held(server)) {
			notice = HELD_BY_UPDATE;
			publish();
			return;
		}
		// The pairing this confirm is about: one made again while it was open is a new one, kept.
		const pairing = store.pairing(server);
		const { response } = await dialog.showMessageBox(controls, {
			type: "warning", noLink: true, buttons: ["Cancel", "Confirm"], defaultId: 0, cancelId: 0,
			message: `Remove ${server} from this device?`,
			detail: "This forgets its pairing and saved credential here. Pair again to add it back.",
		});
		if (response !== 1 || busy || removing || closing || store.damaged || !pairing) return;
		if (store.pairing(server) !== pairing) {
			// Paired again while this confirm was open: that is a new pairing, kept. Removed
			// meanwhile (no pairing now): nothing left to say.
			if (store.pairing(server)) {
				notice = REPAIRED;
				publish();
			}
			return;
		}
		if (held(server)) {
			notice = HELD_BY_UPDATE;
			publish();
			return;
		}
		// Not busy: a failing check of another open server still shows its problem meanwhile.
		removing = server;
		// Its bearer is never sent again: a check still running for it stops now, and so does
		// its ChatGPT sign-in, without the cancel that would carry the bearer.
		const signIns = chatgpt.forget(server);
		if (window && rechecks.get(window)?.server === server) rechecks.get(window).stop.abort();
		// Its window closes before the write: its page's own requests carry the bearer too.
		// The list comes first, so the app always has a window, and stays in front for the keyboard.
		if (active?.server === server) { show(); destroyContent(); }
		publish();
		try {
			await store.remove(server);
			if (problem?.server === server) problem = null;
			notice = "";
		} catch {
			// A write can fail after it already took effect (its cleanup, say): then the server is
			// gone, and so is its bearer.
			const gone = !store.origins.includes(server);
			if (gone && problem?.server === server) problem = null;
			notice = gone ? "" : "Couldn’t remove the saved server.";
			// The sign-in's skipped cancel goes out after all, so the server doesn't hold that
			// attempt pending until its own timeout, but only while the same pairing is verifiably
			// still saved, in memory and on disk. Otherwise the bearer is forgotten: never sent.
			if (store.pairing(server) === pairing && await store.persisted(server)) await signIns.kept();
		} finally { removing = null; publish(); }
	}
	// The open remote window's ChatGPT sign-in (window.lh.chatgptSignIn), never for a held server.
	const chatgpt = createRemoteChatGPTSignIn({
		openExternal: (url) => shell.openExternal(url),
		selection: () => (window && !window.isDestroyed() && active?.token && !held(active.server) ? { origin: active.server, token: active.token } : null),
	});
	ipcMain.handle(CHANNEL, async (event, action, value) => {
		if (!controls || controls.isDestroyed() || event.sender !== controls.webContents ||
			event.senderFrame !== controls.webContents.mainFrame || !isShell(event.senderFrame.url)) {
			throw new Error("Untrusted server window request.");
		}
		if (action === "state") return snapshot();
		if (action === "link") return typeof value === "string" && value.length <= 8192 ? parsePairLink(value) : null;
		if (busy || removing || closing) return;
		// Nothing is returned: the window connect resolves with is native and can't cross IPC.
		if (action === "connect" && (value === "local" || store.origins.includes(value))) { await connect(value); return; }
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
		} else if (action === "remove" && !store.damaged && store.origins.includes(value)) {
			await remove(value);
		}
	});
	return {
		/** `check`: Switch server… also checks the open server, so one that went away says so. */
		show({ check = false } = {}) {
			const panel = show();
			if (check && window && active?.token) void recheck(window, active, false, lifetimes.get(window), { retry: true });
			return panel;
		},
		/** `server`: the one Update everything restarted from, reopened once instead of the default. */
		async launch({ server } = {}) {
			if (ghosting) return this.reopen();
			const first = server && !store.damaged && store.origins.includes(server) ? server : store.defaultServer;
			if (first && !held(first)) return connect(first, undefined, { quiet: true });
			show();
		},
		/** The app's content window (a server's page, the bundled app's, or its problem screen),
		 *  never the Switch server… panel or a popup; null while none is open. */
		appWindow() {
			return window && !window.isDestroyed() ? window : null;
		},
		/** The open window onto a paired server, for Update everything and its bridge. */
		current() {
			return window && !window.isDestroyed() && active?.token && removing !== active.server ? { win: window, origin: active.server, token: active.token } : null;
		},
		/** Only the run's own server: after a switch, another server's page stays uncovered. */
		coverForUpdate(origin, text) {
			if (!window || window.isDestroyed() || !active?.token || active.server !== origin) return;
			if (updating) { updating.stop(); updating.cover.reveal(); }
			const win = window;
			// The server restarts under the cover: its ChatGPT sign-in ends.
			chatgpt.abort();
			const cover = coverWindow(win, { WebContentsView, session, mode: themeMode(), status: text });
			cover.focus();
			// The page under the cover reloads itself once the server is back on the new
			// version (#264). The cover blocks every input, so a page load now is that reload.
			const state = { win, origin, cover, reloaded: false };
			const loaded = (_event, url, code) => { if (code >= 200 && code < 400 && atOrigin(url, origin)) state.reloaded = true; };
			win.webContents.on("did-navigate", loaded);
			state.stop = () => { if (!win.isDestroyed()) win.webContents.removeListener("did-navigate", loaded); };
			updating = state;
		},
		/** The run ended without a restart: show its problem in the list (kind "retry" or "pair"),
		 *  or show the server's new page after Later. `version` is the one the server is now on.
		 *  Resolves true when this reloaded the page (Update everything then waits for the new one). */
		async endUpdate(origin, problem, { version } = {}) {
			// Only the covered window of the server the run moved: after a switch, the
			// current window belongs to another server and stays.
			const covered = updating && updating.win === window && !window.isDestroyed() ? updating : null;
			updating?.stop();
			updating = null;
			if (problem) {
				fail(origin, new ServerProblem(problem.kind, problem.message));
				if (covered) destroyContent();
				publish();
				return;
			}
			// Later (or the app install failing after the server committed): keep this window and
			// load the updated server's page in it. A reconnect would destroy the only window first,
			// and Windows and Linux quit when the last one closes (window-all-closed).
			// The page loads the new version exactly once: if it already reloaded itself under
			// the cover, nothing more; otherwise reload it here, after claiming that version in
			// its own once-per-version memory so it doesn't reload itself again on top.
			if (covered) {
				covered.cover.reveal();
				covered.win.focus();
				if (covered.reloaded) return false;
				if (typeof version === "string" && EXACT_VERSION.test(version)) {
					await covered.win.webContents.executeJavaScript(claimReloadScript(version)).catch(() => {});
				}
				if (covered.win.isDestroyed()) return false;
				covered.win.webContents.reload();
				return true;
			}
			return false;
		},
		reopen() {
			if (ghosting) {
				// Its window may not exist yet while the saved credential is read.
				if (window && !window.isDestroyed()) window.focus();
				return window;
			}
			if (active && held(active.server)) {
				if (!window || window.isDestroyed()) return show();
				window.focus();
				return window;
			}
			if (active) return connect(active.server, undefined, { quiet: true });
			if (problem || busy || removing) return show();
			return this.launch();
		},
		close() {
			closing = true;
			connecting?.abort();
			chatgpt.abort();
		},
		/** window.lh.chatgptSignIn from the open remote window (electron/remote-chatgpt-ipc.cjs). */
		chatgptSignIn: (accountId) => (active && held(active.server) ? { error: HELD_BY_UPDATE } : chatgpt.signIn(accountId)),
		chatgptCancel: () => chatgpt.cancel(),
	};
}

module.exports = { createServerList, AUTO_RELOAD_KEY, AUTO_RELOAD_MEMORY, claimReloadScript };
