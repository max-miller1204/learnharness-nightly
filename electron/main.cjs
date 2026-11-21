/**
 * LearnHarness — the Electron shell (wrapper milestone, 2026-09-17).
 *
 * What this process is and is not:
 *   IS:  a thin launcher + security guard around the app's real server —
 *        `next build`'s standalone server.js (Next 16), spawned as a child
 *        on 127.0.0.1 with the BYOK auth file and the LH_DATA_DIR seam.
 *   NOT: a host for any app logic. Everything — teacher turns, extraction,
 *        the graph — runs in the Next server, unchanged.
 *
 * Pattern (fact-checked 2026-09-17 against current Electron 44 / Next 16
 * docs — see .memory release-strategy + electron-wrapper notes):
 *   - spawn via process.execPath + ELECTRON_RUN_AS_NODE=1 (Electron's
 *     bundled Node 24; the runAsNode fuse must stay enabled);
 *   - the server dir ships UNPACKED via extraResources (asar archives are
 *     read-only and native .node/dylib can't dlopen from one);
 *   - all mutable state under userData (never inside the .app bundle —
 *     translocated apps are read-only);
 *   - keys ride the child's ENV, never argv; auth.json (BYOK) is a flat
 *     {VAR: value} JSON map, plaintext, mode 0600 — server-managed since
 *     the auth-keys wave (2026-09-19): the child reads/writes it DIRECTLY
 *     (LH_AUTH_FILE below) and reflects values into its own env. The old
 *     spawn-time env injection retired with that wave — a copy made here
 *     would shadow every settings-page key change until restart.
 */

const { app, BrowserWindow, WebContentsView, Menu, ipcMain, nativeTheme, session, shell, dialog, safeStorage } = require("electron");
const { pickAttachmentPath } = require("./attachment-picker.cjs");
const { createChatGPT, fileStore } = require("./chatgpt.cjs");
const { attachChatGPTChild, trustedSender, chatGPTControl } = require("./chatgpt-ipc.cjs");
const { createSubscriptions, loadSubscriptionSDK } = require("./subscriptions.cjs");
const { attachSubscriptionChild, subscriptionControl } = require("./subscription-ipc.cjs");
const { desktopAPIHeaders, exchangeDesktopSession } = require("./desktop-api.cjs");
const { setTraceSink } = require("./first-frame.cjs");
const { createServerList } = require("./server-list.cjs");
const { createUpdateEverything } = require("./update-everything.cjs");
const { registerDesktopUpdateIPC } = require("./update-everything-ipc.cjs");
const { registerChatGPTSignInIPC } = require("./remote-chatgpt-ipc.cjs");
const { createUpdateActions } = require("./update-actions.cjs");
const { requestServer } = require("./remote-server.cjs");
const { openWebSubscriptionBrowser } = require("./web-subscription-browser.cjs");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { URL } = require("node:url");

// Mirrors SIDEBAR_AUTOCLOSE in components/sidebar.tsx — keep in sync (the
// renderer owns the number; this is the IPC widen target).
const SIDEBAR_AUTOCLOSE = 928;

const PRODUCT_NAME = "LearnHarness Nightly";

// Set the profile name before resolving userData or taking the instance lock.
app.setName(process.env.LH_DEV_URL ? "LearnHarness" : PRODUCT_NAME);
const AUTH_FILE = () => path.join(app.getPath("userData"), "auth.json");
const DATA_DIR = () => path.join(app.getPath("userData"), "data");

// Resolve the saved palette before window creation; renderer reports keep
// it current after live saves. This helper needs no compiled server bundle.
const { normalizeAppearance, themeSourceFor, serverDataDir, readAppearance, chromeColors } = require("./appearance-chrome.cjs");
let appearance = normalizeAppearance(null);

function applyChrome(win) {
	if (win.isDestroyed()) return;
	const colors = chromeColors(appearance);
	win.setBackgroundColor(colors.color);
	if (process.platform !== "darwin") win.setTitleBarOverlay(colors);
}

/** The packaged standalone server (extraResources → Resources/server).
 *  In dev LH_DEV_URL short-circuits everything: no spawn, no packaging —
 *  the window points at the running `next dev` server (full HMR). */
function serverEntry() {
	// extraResources ships the whole .next payload under server/standalone/
	// (copied from .next with an explicit filter — see electron-builder.yml).
	return path.join(process.resourcesPath, "server", "standalone", "server.js");
}

// ─── Single instance: two instances would fight over the data dir ─────────
// ─── Browser-service helper (Wave E stage 3, owner 2026-10-10) ────────
// The render engines for agent jobs: PDFs and SVGs rasterize natively
// (pdfjs+Skia, resvg — no browser); DEMOS execute JS and need one. The
// app's own Chromium serves that via this helper — the server spawns
//   <this binary> --browser-service
// and connects over CDP (system Chrome stays the fallback). Handshake:
// the helper prints "BROWSER_SERVICE_CDP <port>" on stdout once the CDP
// endpoint listens. Lifetime: parent IPC disconnect/death = quit.
// MUST run before the single-instance lock — a helper is a second
// instance of this very binary, and before the LH_DEV_URL redirect — the
// helper owns no user data at all.
if (process.argv.includes("--browser-service")) {
	const { waitForBrowserService } = require("./browser-service-readiness.cjs");
	// Own the helper's entire startup lifetime, including the readiness wait.
	const lifetime = new AbortController();
	const parentClosed = () => {
		lifetime.abort(new Error("browser-service parent IPC disconnected"));
		app.quit();
	};
	(async () => {
		try {
			// Full Windows Electron replaces stdin with synthetic EOF. Use the
			// real Node IPC channel, and refuse to start an unowned helper.
			if (!process.channel || !process.connected) throw new Error("browser-service requires connected parent IPC");
			process.once("disconnect", parentClosed);
			app.dock?.hide();
			const port = await freePort();
			// Must land before app-ready for Chromium to pick it up.
			app.commandLine.appendSwitch("remote-debugging-port", String(port));
			await app.whenReady();
			// A hidden window keeps the app lifecycle ordinary on every
			// platform (no window-all-closed handler is installed here).
			const win = new BrowserWindow({ show: false });
			await win.loadURL("about:blank");
			// Window load is not a DevTools HTTP readiness barrier. Confirm the
			// endpoint before both production and smoke clients see the handshake.
			await waitForBrowserService(port, { signal: lifetime.signal });
			if (!lifetime.signal.aborted) console.log(`BROWSER_SERVICE_CDP ${port}`);
		} catch (err) {
			if (lifetime.signal.aborted) return; // Parent disconnect is normal.
			console.error("browser-service failed:", err);
			app.exit(1);
		}
	})();
} else {
	// Dev shell (LH_DEV_URL) runs BESIDE the packaged app, not instead of it:
	// its own userData so (a) the single-instance lock — checked below — doesn't
	// silently kill it, and (b) it never reads/writes the real app's
	// localStorage, auth.json, or logs. Must run before the lock check.
	if (process.env.LH_DEV_URL) {
		app.setPath("userData", `${app.getPath("userData")}-dev`);
	}

	// The whole normal boot — lock included — lives in this else: a helper is
	// a SECOND instance of this very binary on purpose (the running app owns
	// the lock), so it must never reach this check.
	if (!app.requestSingleInstanceLock()) {
		app.quit();
	} else {
		app.on("second-instance", () => {
			const win = BrowserWindow.getAllWindows()[0];
			if (!win) reopenWindow?.();
			if (win) {
				if (win.isMinimized()) win.restore();
				win.focus();
			}
		});
		main();
	}
}

let serverProcess = null;
// Each app window's own load(), which also moves its allowed origin (createWindow).
const windowLoaders = new WeakMap();
let chatgpt = null;
let chatgptChild = null;
let subscriptions = null;
let subscriptionChild = null;
// Per-launch secret, traded once for a desktop login session (never renderer state).
let desktopAPISecret = null;
let desktopSessionToken = null;
let reopenWindow = null;
let localOrigin = null;
// The bundled server's last origin: a window still on it may claim its update notices after a
// restart that failed (stopping the backend clears localOrigin).
let lastLocalOrigin = null;
let serverList = null;
const trustedAppWindows = new Set();

// A GUI shell must never die to a stray exception (EPIPE dialogs, a race
// in an event handler): the window + child server are the product, and
// anything main-side is recoverable by logging it. Log-and-continue.
process.on("uncaughtException", (err) => {
	try {
		log(`uncaught: ${err?.stack ?? err}`);
	} catch {
		/* nothing left to write to */
	}
});

/** A free TCP port (listen(0) → the kernel assigns one). The close→spawn
 *  race is theoretical; localhost ports are rarely contended, and a failed
 *  spawn surfaces in the health check with the child's stderr in the log. */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** BYOK keys: auth.json in userData, flat {VAR: value} map, 0600 —
 *  SERVER-MANAGED since the auth-keys wave (2026-09-19). This shell no
 *  longer reads or injects it: the child gets LH_AUTH_FILE below and does
 *  its own read/reflect/write, so a key saved in the settings page takes
 *  effect on the next model call — no restart. Real environment variables
 *  still win over the file inside the child (its documented rule). */

setTraceSink((line) => log(line));
function log(line) {
	const stamp = new Date().toISOString();
	// The stdout write is guarded (EPIPE hardening, 2026-10-10): a packaged
	// app launched with a consumer-owned pipe (a launcher that exits, a
	// piped run) must not die on its next log line when the pipe breaks.
	// The file below stays the durable channel.
	try {
		console.log(`[lh ${stamp}] ${line}`);
	} catch {
		/* stdout gone — userData/logs/main.log still carries it */
	}
	// Belt and braces: also append to userData/logs so a misbehaving child
	// can be diagnosed after the window is gone. Best effort only.
	try {
		const dir = path.join(app.getPath("userData"), "logs");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "main.log"), `[${stamp}] ${line}\n`);
	} catch {
		/* best effort */
	}
}

function startServer(port) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			// Only the macOS backend needs this: Next's native title setter
			// otherwise checks this Node-mode process in as a foreground app.
			process.platform === "darwin"
				? ["--require", path.join(process.resourcesPath, "server-title-guard.cjs"), serverEntry()]
				: [serverEntry()],
			{
				cwd: path.dirname(serverEntry()),
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: "1",
					NODE_ENV: "production",
					PORT: String(port),
					HOSTNAME: "127.0.0.1", // the server defaults to 0.0.0.0 — never
					LH_DATA_DIR: DATA_DIR(),
					// The auth/keys store — the child reads AND writes this file itself
					// (no env injection anymore: a spawn-time copy would shadow every
					// settings-page key change until restart; env wins over file).
					LH_AUTH_FILE: AUTH_FILE(),
					LH_DESKTOP_SERVER: "1",
					LH_DESKTOP_API_SECRET: desktopAPISecret,
				},
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		serverProcess = child;
		chatgptChild = attachChatGPTChild(child, chatgpt);
		subscriptionChild = attachSubscriptionChild(child, subscriptions);
		const fwd = (buf) => buf.toString().trimEnd().split("\n").forEach((l) => l && log(`server: ${l}`));
		child.stdout.on("data", fwd);
		child.stderr.on("data", fwd);
		child.once("error", reject);
		child.once("close", (code, signal) => {
			log(`server exited (code=${code} signal=${signal})`);
			if (serverProcess !== child) return;
			serverProcess = null;
			disposeLocalBackend();
		});
		child.once("spawn", () => resolve(child));
	});
}

/** No "ready" event exists — poll until the server answers (docs-confirmed). */
function waitUntilUp(url, child, tries = 150) {
	return new Promise((resolve, reject) => {
		const attempt = (n) => {
			if (serverProcess !== child || !child.connected) return reject(new Error("Bundled server stopped before startup completed."));
			const req = http.get(url, (res) => {
				res.resume();
				resolve(res.statusCode !== undefined);
			});
			req.setTimeout(1000, () => req.destroy());
			req.on("error", () => {
				if (n <= 0) reject(new Error(`server never answered on ${url}`));
				else setTimeout(() => attempt(n - 1), 200);
			});
		};
		attempt(tries);
	});
}

function disposeLocalBackend() {
	localOrigin = null;
	desktopAPISecret = null;
	desktopSessionToken = null;
	chatgptChild?.dispose();
	chatgptChild = null;
	subscriptionChild?.dispose();
	subscriptionChild = null;
	chatgpt?.close();
	chatgpt = null;
	subscriptions?.close();
	subscriptions = null;
}

function killServer() {
	const child = serverProcess;
	disposeLocalBackend();
	if (!child) return Promise.resolve();
	return new Promise((resolve) => {
		const force = setTimeout(() => child.kill("SIGKILL"), 3000);
		force.unref();
		child.once("close", () => { clearTimeout(force); resolve(); });
		child.kill("SIGTERM");
	});
}

/** Links leaving the app window may open only in a browser or mail client:
 *  the same schemes chat markdown makes clickable. Other schemes (smb:,
 *  file:, search-ms:, any app's custom handler) are dropped, and only the
 *  scheme is logged. */
const EXTERNAL_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);
function openExternalLink(target) {
	let scheme = "unparseable";
	try {
		scheme = new URL(target).protocol;
	} catch { /* logged below */ }
	if (EXTERNAL_LINK_SCHEMES.has(scheme)) {
		void shell.openExternal(target);
		return;
	}
	log(`external link blocked (scheme ${scheme.slice(0, 40)})`);
}

/** Security posture (all defaults asserted explicitly; the guards are the
 *  checklist's own recommendations for localhost-app shells):
 *  - deny-by-default permission handler allowing only our loopback origin
 *    (groundwork for the mic/STT milestone — Electron auto-approves by
 *    default, we do not);
 *  - will-navigate pinned to the app origin; window.open always denied —
 *    external links go to the real browser via shell.openExternal, for
 *    http, https and mailto only (openExternalLink). */
function createWindow(url) {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		title: PRODUCT_NAME,
		// Merged chrome (owner, 2026-09-17): the system title bar is gone;
		// the app's own 60px header bands ARE the title bar. The traffic
		// lights float over the sidebar's LH wordmark band, vertically
		// Aligned to the PHASE PILL's drawn box, not the band's geometric
		// center (owner ask, 2026-09-17): macOS centers each 12px circle at
		// y+6.75, and the pill box center measures 29.25 in the running app
		// (band 0–59.5, pill box 19–39.5) — y 22.5 lands the circles at
		// 29.25, exactly on the pill. Wordmark gutter: components/sidebar.tsx.
		// Dragging comes from the renderer's .lh-drag bands (app/globals.css).
		...(process.platform === "darwin"
			? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 22.5 } }
			: {
				titleBarStyle: "hidden",
				// Native min/max/close on the right, at the OS's compact default
				// height. Do not force the zoom-invariant native overlay to match
				// the renderer's 60 CSS px bar: zooming out would cover its border.
				// The renderer reserves the actual width via env(titlebar-area-*).
				titleBarOverlay: chromeColors(appearance),
				// Keep the custom bar alone; Alt reveals the native menu.
				autoHideMenuBar: true,
			}),
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			...(process.env.LH_DEV_URL ? { additionalArguments: ["--lh-web-subscriptions"] } : {}),
			preload: path.join(__dirname, "preload.cjs"),
		},
		// Live-resize + first-paint flash (owner, 2026-09-17): during a resize
		// the native window surface changes size before Chromium's compositor
		// has a frame at the new size, and the gap shows the window's NATIVE
		// background — Electron's default is white, glaring on a dark app.
		// The app's background for the rendered mode fills the lag instead
		// (chromeColors). `show: false` + ready-to-show is the same treatment
		// for first paint: the window appears only once the page has
		// actually rendered.
		backgroundColor: chromeColors(appearance).color,
		show: false,
		// Narrow-window behavior (owner, 2026-09-17): 640px is the floor —
		// below it even a wrapped chrome row gets cramped and the chat header
		// (lights gutter 92 + toggle + title) runs out of room. The sidebar
		// auto-closes below 928 = 640 + 288 (sidebar) in the renderer
		// (components/sidebar.tsx, SIDEBAR_AUTOCLOSE); its "lh:expand-window"
		// IPC widens the window back to that threshold.
		minWidth: 640,
		minHeight: 600,
	});

	trustedAppWindows.add(win);
	win.once("closed", () => trustedAppWindows.delete(win));
	// Without a URL the window waits, unshown, for its caller to cover it
	// with the ghost dashboard and later load the bundled server.
	// (undefined matches no request origin, which may be null.)
	let appOrigin = url ? new URL(url).origin : undefined;
	const allowedOrigin = () => appOrigin;
	// Deny-by-default; the ONLY grants are media (mic/STT groundwork) and
	// clipboard-sanitized-write — the copy affordances in the transcript
	// (md-blocks copy corners) call navigator.clipboard.writeText(), which
	// Chromium only honors with that permission (chrome-melt tweaks wave,
	// 2026-09-19; before this grant every copy silently rejected). Still
	// loopback-origin only — Electron's default is auto-approve-everything,
	// and we do not ship that.
	// "local-fonts": the appearance section's reading-font picker (2026-09-26).
	const allowedPermissions = new Set(["media", "clipboard-sanitized-write", "local-fonts"]);
	const fromOwnOrigin = (origin, permission) =>
		origin === allowedOrigin() && allowedPermissions.has(permission);
	session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
		const requestOrigin = details.requestingUrl ? new URL(details.requestingUrl).origin : null;
		callback(fromOwnOrigin(requestOrigin, permission));
	});
	session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
		return fromOwnOrigin(origin, permission);
	});

	win.webContents.on("will-navigate", (event, target) => {
		if (new URL(target).origin !== allowedOrigin()) {
			event.preventDefault();
			openExternalLink(target);
		}
	});
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		openExternalLink(target);
		return { action: "deny" };
	});

	const load = (target) => {
		appOrigin = new URL(target).origin;
		return win.loadURL(target);
	};
	windowLoaders.set(win, load);
	if (url) void load(url);
	// Zoom truth reaches the renderer for EVERY load (reload, nav): the
	// renderer's --lh-zoom must never go stale. The fallback catcher below
	// covers ⌘= / layout variants the menu's ⌘Plus may not claim — menu-
	// claimed keys never reach before-input-event, so exactly one of the
	// two applies any given zoom keypress.
	win.webContents.on("did-finish-load", () => {
		win.webContents.send("lh:zoom", win.webContents.getZoomFactor());
	});
	win.webContents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown" || !(input.meta || input.control)) return;
		if (input.key === "=" || input.key === "+") zoomStep(win, +1);
		else if (input.key === "-") zoomStep(win, -1);
		else if (input.key === "0") applyZoom(win, 1);
		else return;
		event.preventDefault();
	});

	if (url) win.once("ready-to-show", () => win.show());
	return { win, load };
}

/* ── Zoom (owner round 7, 2026-10-05): ⌘±/⌘0 as an OWNED ladder ──────────
 * The stock zoomIn/zoomOut roles change zoomLevel silently — the renderer
 * never learns the factor, and the native traffic lights (physical-fixed,
 * hiddenInset) drift out of relation to the scaled chrome: the graph
 * button rides away from them zoomed in, content slides under them
 * zoomed out. Here zoom is explicit: a factor ladder, applied through
 * setZoomFactor, and broadcast to the renderer ("lh:zoom" — it publishes
 * --lh-zoom so gutter lengths can divide by it and stay PHYSICAL-
 * constant). The traffic lights themselves stay at their construction
 * position ({x:16, y:22.5} — Electron 44 has NO runtime setter, only
 * the BrowserWindow option), which is HIG-correct anyway: native lights
 * hug the window corner while the web chrome compensates around them.
 * Vertical note: at large factors the taller bands' content centers
 * drift below the fixed lights — accepted (the alternative, moving the
 * lights, is impossible without rebuilding the window). */
const ZOOM_LADDER = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/* ── Auto-update (T3 style: docs/specs/t3-style-updates.md, section 4) ────
 * Checks 15 s after launch and every 4 hours (gated by Settings' "Check for
 * updates automatically"), downloads ONLY when the user clicks Download,
 * installs ONLY when the user confirms Install (never on quit). Install
 * first re-checks: a release published since the download replaces it
 * (T3 Code's apps/desktop/src/updates/DesktopUpdates.ts rule).
 *
 * Nightlies discover the exact GitHub tag through nightly/latest.json.
 * macOS uses a Developer ID-signed app and the ZIP target (Squirrel.Mac).
 * Windows uses NSIS with differential downloads. Linux uses AppImage
 * or DebUpdater (6.8.9 supports deb; installation can request
 * administrator permission via the package manager - owner 2026-10-11).
 *
 * Hard rules:
 *  - DEV NEVER UPDATES: !app.isPackaged skips the updater entirely - the
 *    dev world runs `next dev` and has no signed bundle.
 *  - THE UPDATER CAN NEVER TAKE THE APP DOWN: every event and check is
 *    caught and logged (feed down, disk full, bad signature - all just
 *    log lines; the app keeps working, update or no update).
 *  - LH_UPDATE_FEED (env): overrides the baked GitHub feed with a generic
 *    local server - the pre-release verification drill (serve
 *    latest-mac.yml + zip + blockmap from any localhost HTTP dir and
 *    watch a real installed copy find/download/restart). Test-only seam.
 *
 * Release notes from nightly/latest.json or the default GitHub updater
 * become ReleaseNoteGroup[] (electron/release-notes.cjs)
 * for the pill; before installing they are saved to the data folder's
 * notes cache, which the What's new popup reads after the relaunch.
 *
 * Install path: we kill the child server FIRST - deterministic ordering:
 * the server lives inside the .app bundle Squirrel is about to replace
 * (extraResources), and before-quit alone would race the swap. */
const UPDATE_STARTUP_DELAY_MS = 15 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const releaseNotes = require("./release-notes.cjs");
let autoUpdater = null; // electron-updater's, packaged builds only
const updateMachine = require("./update-machine.cjs");
// Observational only: this snapshot NEVER gates electron-updater's own work.
// The revision lets late subscribers reject an older in-flight IPC snapshot.
// T3's state (electron/update-machine.cjs): status, availableVersion,
// downloadedVersion, checkedAt, message, errorContext, canRetry, the offered
// version's notes, `downloadPercent` (0 to 100, or null when unknown, the
// sidebar's progress ring), and LearnHarness's `version` for its readers.
let updateState = updateMachine.createInitialUpdateState();
// Every group of the offered version (uncapped): the notes cache keeps them all.
let offeredGroups = [];
let installing = false;
// quitAndInstall was called: an updater error from here on is the install's (not its re-check's or download's).
let quitRequested = false;
// A check or a download of ours is running: its own promise reports the outcome, not the "error" event.
let activeAction = null;
// The running check's promise, so a Download click can wait for it (T3's admitAfterCheck).
let activeCheck = null;
// The install's quit watch, and the bundled server's stop for it (recovery waits for it, then starts it again).
let installWatch = null;
let serverStoppedForInstall = null;
// The install this launch didn't apply (T3's notAppliedVersion), from the install record.
let notAppliedVersion = null;
// The notices the page shows once per launch (revision PR 4): main owns "once", so a reload, a
// new port or a new local window never repeats one. "not-applied:<version>" for the launch's
// install record; "install-failed:<n>" for an install the sidebar started that failed, with its
// fixed text, carried only until the next state change (then it is no longer current).
// Two steps: a visible page claims a notice (reserved for that page), shows the toast, then acks
// it (shown). A page that navigates or closes before its ack gives its reservation back.
let installFailedNotice = 0;
let installNotice = null; // { id, message } while current
let installNotifies = false; // the running install was started from the sidebar
const shownNotices = new Set();
const reservedNotices = new Map(); // key -> the webContents that reserved it
const NOTICE_KEY = /^(?:install-failed:[1-9]\d{0,5}|not-applied:\d+\.\d+\.\d+(?:-[a-z]+\.\d{8}\.\d+)?)$/;

const currentNotice = (key) => key === (key.startsWith("install-failed:") ? `install-failed:${installNotice?.id}` : `not-applied:${notAppliedVersion}`);

/** Reserves `key` for `contents` when it is a notice the state carries now and no page showed it yet. */
function claimUpdateNotice(key, contents) {
	if (typeof key !== "string" || !NOTICE_KEY.test(key) || shownNotices.has(key) || !currentNotice(key)) return false;
	const holder = reservedNotices.get(key);
	if (holder && holder !== contents && !holder.isDestroyed?.()) return false;
	reservedNotices.set(key, contents);
	const release = () => { if (reservedNotices.get(key) === contents) reservedNotices.delete(key); };
	contents?.once?.("destroyed", release);
	contents?.once?.("did-start-navigation", release);
	return true;
}

/** The page showed the toast for `key`: no page shows it again this launch. */
function ackUpdateNotice(key, contents) {
	if (typeof key !== "string" || reservedNotices.get(key) !== contents) return false;
	reservedNotices.delete(key);
	shownNotices.add(key);
	return true;
}

/** A failed install the sidebar started becomes the page's notice, with its fixed text. */
function noticeInstallFailure(message) {
	if (!installNotifies) return;
	installNotifies = false;
	installFailedNotice += 1;
	installNotice = { id: installFailedNotice, message };
	setUpdateState({ ...updateState }, { notice: true });
}

const nowIso = () => new Date().toISOString();
// The state's `message` is fixed text per context: raw updater errors (paths, URLs) go to the log only.
const CHECK_FAILED = "Couldn’t check for updates. Try again later.";
const DOWNLOAD_FAILED = "Couldn’t download the update. Try again.";
const UPDATE_FAILED = "Something went wrong with the update. Try again later.";
const INSTALL_FAILED = "Couldn’t install the update.";

/**
 * An install that failed before the app quit, as T3's recoverFailedInstall (DesktopUpdates.ts:
 * 829-858, called from its updater-error handler at :1136-1144): only T3's install failure, so the
 * state stays "downloaded" with the install context and Install works again; the quit watch and
 * the install record go (it was never applied); and the bundled server stopped for the install
 * starts again, with the local window reloaded onto it.
 */
function recoverFailedInstall() {
	// T3's ownsRecovery: only the install that is still the active action recovers, once.
	if (!installing || activeAction !== "install") return;
	activeAction = null;
	if (installWatch) {
		clearTimeout(installWatch.timer);
		app.removeListener("before-quit", installWatch.markQuitting);
		installWatch = null;
	}
	installing = false;
	quitRequested = false;
	removeInstallRecord();
	setUpdateState(updateMachine.reduceOnInstallFailure(updateState, INSTALL_FAILED));
	// An Update everything run waiting on this install ends with a retryable failure.
	updateEverything?.installFailed?.();
	const stopped = serverStoppedForInstall;
	serverStoppedForInstall = null;
	// The page's "Could not install update" toast follows this notice. With the server to bring
	// back, only once its windows reloaded onto it: a toast raised before would go with the old page.
	const notify = () => noticeInstallFailure(INSTALL_FAILED);
	// T3 restarts its backends once they stopped: the old child's close would otherwise dispose the
	// new backend, and two servers would share the data folder.
	if (stopped) {
		void stopped
			.then(() => restartLocalAfterFailedInstall())
			.catch((err) => log(`could not restart the server after a failed install: ${err?.message ?? err}`))
			.finally(notify);
	} else notify();
}

/**
 * The bundled server again, then each local window onto it, the way a launch loads one: only once
 * startLocalServer has it answering with this app's desktop session (waitUntilUp, then the session
 * exchange), and from a blank page, as a new window starts. The desktop session's bearer goes only
 * to the main frame of a page that is blank, the ghost dashboard or the server's own origin
 * (electron/desktop-api.cjs); straight from the old port's page the first request would carry none
 * and the app would ask to pair. Each window loads through its own load(), so its permissions and
 * same-origin navigation follow the new port.
 */
async function restartLocalAfterFailedInstall() {
	const url = await startLocalServer(new AbortController().signal);
	if (!desktopSessionToken || !localOrigin) throw new Error("The bundled server has no desktop session.");
	for (const win of trustedAppWindows) {
		if (win.isDestroyed()) continue;
		const load = windowLoaders.get(win);
		try {
			await win.loadURL("about:blank");
			await (load ? load(url) : win.loadURL(url));
		} catch { /* its own load error stays in the window */ }
	}
}
const offeredNotes = () => releaseNotes.capGroups(offeredGroups);
const INSTALL_RECORD = () => path.join(app.getPath("userData"), updateMachine.INSTALL_RECORD_FILE);

/** Broadcast the next state (a reducer's result); the revision moves on. Any change but the
 *  notice's own ends the install notice: it is no longer current. */
function setUpdateState(next, { notice = false } = {}) {
	try {
		if (!notice) installNotice = null;
		const { installFailedNotice: _id, installFailedNoticeMessage: _message, ...rest } = next;
		updateState = {
			...rest,
			revision: updateState.revision + 1,
			...(notAppliedVersion ? { notAppliedVersion } : {}),
			...(installNotice ? { installFailedNotice: installNotice.id, installFailedNoticeMessage: installNotice.message } : {}),
		};
		for (const win of trustedAppWindows) {
			try {
				win.webContents.send("lh:update-status", updateState);
			} catch {
				/* window mid-teardown - snapshot retrieval covers a later load */
			}
		}
	} catch {
		/* Status reporting must never interrupt the updater. */
	}
}

/** Read the install record once at launch: still on its old version means the install didn't apply. */
function readInstallRecord() {
	try {
		const record = JSON.parse(fs.readFileSync(INSTALL_RECORD(), "utf8"));
		notAppliedVersion = updateMachine.resolveNotAppliedInstallVersion(record, app.getVersion());
	} catch {
		notAppliedVersion = null;
	}
	// Applied, a downgrade below its starting version, or unreadable: the record has said all it can.
	if (notAppliedVersion) log(`auto-update: the last update install did not apply (still ${app.getVersion()}, meant ${notAppliedVersion})`);
	else removeInstallRecord();
}

function removeInstallRecord() {
	try { fs.rmSync(INSTALL_RECORD(), { force: true }); } catch { /* none */ }
}

function writeInstallRecord(targetVersion) {
	try {
		fs.writeFileSync(INSTALL_RECORD(), JSON.stringify({ fromVersion: app.getVersion(), targetVersion }));
	} catch (err) {
		log(`could not record the update install: ${err?.message ?? err}`);
	}
}

/** T3's shouldBroadcastDownloadProgress (apps/desktop/src/updates/DesktopUpdates.ts:325-341 at
 *  3ce21458): a new state only on entering "downloading", at each whole 10%, and at 100%. */
function shouldReportDownloadProgress(state, percent) {
	if (state.status !== "downloading") return true;
	if (percent === null) return false; // no size: the ring stays empty
	if (state.downloadPercent === null) return true;
	return Math.floor(percent / 10) !== Math.floor(state.downloadPercent / 10) || percent === 100;
}

function adoptOfferedNotes(info) {
	try {
		const groups = releaseNotes.releaseNoteGroups(info);
		// A newer offer replaces the notes; a repeat of the same version keeps richer ones.
		if (groups.length > 0 || offeredGroups[0]?.version !== info?.version) offeredGroups = groups;
	} catch (err) {
		log(`update notes unreadable: ${err?.message ?? err}`);
	}
}

/** Resolves T3's check result (DesktopUpdates.ts:576-626): `checked` false when no check ran
 *  (updates unavailable, or another action of ours is under way), true once one ran, whatever it
 *  found (a failed check shows in the state). The sidebar's "Could not check for updates" toast
 *  reads it. */
function checkForUpdates() {
	if (!autoUpdater) return Promise.resolve({ checked: false });
	// Do not gate on display state: a stale spinner or error must never disable future background
	// checks. Only a check or download of ours still running skips this one, as T3's active action
	// does (DesktopUpdates.ts:583-591); electron-updater owns the rest of its in-flight work.
	// Nor during an install: its feed errors must never read as the install's.
	if (activeAction || installing) return Promise.resolve({ checked: false });
	activeAction = "check";
	activeCheck = autoUpdater
		.checkForUpdates()
		.then((result) => {
			// A declined check (e.g. an unsupported package) establishes no
			// latest-version claim. Real results arrive through updater events.
			if (!result && !updateMachine.isOffered(updateState)) setUpdateState({ ...updateState, status: "idle" });
		})
		.catch((err) => {
			log(`update check failed: ${err?.message ?? err}`);
			// A download under way stays on screen, its own promise reports how it ends; and an offer
			// stays through a failed check, with its notes (docs/specs/t3-style-updates.md, PR 3).
			if (updateState.status !== "downloading" && updateState.status !== "available") setUpdateState(updateMachine.reduceOnCheckFailure(updateState, CHECK_FAILED, nowIso()));
		})
		.finally(() => { activeAction = null; activeCheck = null; });
	return activeCheck.then(() => ({ checked: true }));
}

/** Download the offered version (the user clicked Download, also to retry a failed download).
 *  A check running now finishes first, then the click is admitted (T3's admitAfterCheck,
 *  DesktopUpdates.ts:526-540, 640-644). Re-checks first, as T3 does (:658-674): electron-updater
 *  downloads what its last check found, which can be hours old. A failed re-check keeps the known
 *  offer, which still downloads; a re-check that finds nothing (the release was pulled) clears
 *  the offer and downloads nothing. Resolves T3's action result (DesktopUpdates.ts:628-768):
 *  `accepted` once admitted, `completed` once downloaded; the sidebar's toasts read it. */
/** `expect`: the menu's Download names the version its dialog showed; a re-check that finds
 *  another one downloads nothing (the state then offers what the feed names). */
async function downloadUpdateNow({ expect = null } = {}) {
	const refused = { accepted: false, completed: false };
	if (!autoUpdater || installing || updateEverything?.running()) return refused;
	if (activeAction === "check" && activeCheck) await activeCheck.catch(() => {});
	if (activeAction || installing || updateEverything?.running() || !updateMachine.hasDownloadableOffer(updateState)) return refused;
	activeAction = "download";
	// The offer as clicked: a failed re-check downloads it as known (from "error" too).
	const clicked = updateState;
	try {
		let pulled = false;
		const nothingOffered = () => { pulled = true; };
		autoUpdater.on("update-not-available", nothingOffered);
		try {
			await autoUpdater.checkForUpdates();
		} catch (err) {
			log(`download re-check failed: ${err?.message ?? err}; downloading the known offer`);
		} finally {
			autoUpdater.removeListener("update-not-available", nothingOffered);
		}
		if (pulled) {
			log("download re-check: the feed no longer offers it; nothing downloads");
			setUpdateState(updateMachine.reduceOnNoUpdate(updateState, nowIso()));
			return { accepted: true, completed: false };
		}
		if (!updateMachine.hasDownloadableOffer(updateState)) {
			if (updateState.status !== "checking") return { accepted: true, completed: false };
			setUpdateState({ ...clicked });
		}
		if (expect !== null && updateState.availableVersion !== expect) {
			log(`menu download: the feed now offers ${updateState.availableVersion}, not ${expect}; nothing downloads`);
			return { accepted: true, completed: false, superseded: true };
		}
		setUpdateState(updateMachine.reduceOnDownloadStart(updateState));
		try {
			await autoUpdater.downloadUpdate();
		} catch (err) {
			log(`update download failed: ${err?.message ?? err}`);
			setUpdateState(updateMachine.reduceOnDownloadFailure(updateState, DOWNLOAD_FAILED));
			return { accepted: true, completed: false };
		}
		return { accepted: true, completed: updateState.status === "downloaded" };
	} finally {
		activeAction = null;
	}
}

// A quitAndInstall that does not quit (a cancelled admin prompt, a missing
// installer) leaves the app without its server: relaunch onto the old version.
const INSTALL_QUIT_GRACE_MS = 10 * 1000;

/** Whether a confirmed Install goes ahead now (or one is already under way). Not while an Update
 *  everything run owns its pinned install (electron/update-everything.cjs), nor with nothing staged. */
function installAccepted() {
	return installing || (!!autoUpdater && updateMachine.hasInstallableDownload(updateState) && !updateEverything?.running());
}

/** The user confirmed Install: re-check, take a newer build if one appeared, then quit and install. */
/** `fromSidebar`: the sidebar control started it, so its failure is the page's notice (Settings,
 *  the menu and Update everything report theirs their own way). */
/** `expect`: the menu's Restart names the version its dialog showed. Another one staged, or a
 *  newer one the re-check finds, installs nothing: the state then offers what the feed names,
 *  and it resolves { superseded: true } for the menu to say so. */
async function installUpdateNow({ fromSidebar = false, expect = null } = {}) {
	if (installing || !installAccepted()) return undefined;
	if (expect !== null && updateState.downloadedVersion !== expect) return { superseded: true };
	installing = true;
	installNotifies = fromSidebar;
	// Installing again after a failed install: the last failure no longer applies.
	if (updateState.errorContext === "install") setUpdateState({ ...updateState, errorContext: null, message: null });
	const downloaded = updateState.downloadedVersion;
	let offered = null;
	try {
		const result = await autoUpdater.checkForUpdates();
		const version = result?.updateInfo?.version;
		if (typeof version === "string" && typeof downloaded === "string" && releaseNotes.compareVersions(version, downloaded) > 0) offered = result.updateInfo;
	} catch (err) {
		// A failed re-check (feed unreachable) installs what is already downloaded.
		log(`install re-check failed: ${err?.message ?? err}; installing ${downloaded}`);
	}
	if (offered && expect !== null) {
		log(`menu install: the feed now offers ${offered.version}, not the ${expect} its dialog named; nothing installs`);
		installing = false;
		adoptOfferedNotes(offered);
		const notes = offeredNotes();
		setUpdateState(updateMachine.reduceOnUpdateAvailable({ ...updateState, downloadedVersion: null }, offered.version, nowIso(), notes.releaseNotes, notes.omittedReleaseCount));
		return { superseded: true };
	}
	if (offered) {
		log(`install: ${offered.version} is newer than the downloaded ${downloaded}; downloading it first`);
		adoptOfferedNotes(offered);
		// electron-updater empties its cache when it starts a different version: the old download goes.
		const notes = offeredNotes();
		setUpdateState(updateMachine.reduceOnDownloadStart(updateMachine.reduceOnUpdateAvailable({ ...updateState, downloadedVersion: null }, offered.version, nowIso(), notes.releaseNotes, notes.omittedReleaseCount)));
		try {
			await autoUpdater.downloadUpdate();
		} catch (err) {
			// Install nothing; offer the newer one again, with T3's "Download failed for X" retry. From
			// the sidebar it says so too, as T3's installLocalUpdate does with that failed result
			// (apps/web/src/components/sidebar/SidebarUpdatePill.tsx:172-195 at df09ced7).
			log(`install: downloading ${offered.version} failed (${err?.message ?? err}); nothing installed`);
			installing = false;
			setUpdateState(updateMachine.reduceOnDownloadFailure(updateState, DOWNLOAD_FAILED));
			noticeInstallFailure(DOWNLOAD_FAILED);
			return;
		}
	}
	quitAndInstallNow();
}

/** Save the notes for What's new, stop the server, then quit and install the staged update. */
function quitAndInstallNow() {
	try {
		releaseNotes.mergeNotesCache(DATA_DIR(), offeredGroups);
	} catch (err) {
		log(`could not save the release notes for What's new: ${err?.message ?? err}`);
	}
	// Kill the server BEFORE the quit-and-install (see block comment); a recovery waits for its stop.
	const hadServer = !!serverProcess;
	let stopped = Promise.resolve();
	try {
		stopped = killServer();
	} catch {
		/* already dead */
	}
	serverStoppedForInstall = hadServer ? stopped : null;
	// The next launch compares this with its own version: still the old one means it didn't apply (T3).
	if (updateState.downloadedVersion) writeInstallRecord(updateState.downloadedVersion);
	let quitting = false;
	const markQuitting = () => { quitting = true; };
	app.once("before-quit", markQuitting);
	installWatch = {
		markQuitting,
		timer: setTimeout(() => {
			installWatch = null;
			if (quitting) return;
			app.removeListener("before-quit", markQuitting);
			installing = false;
			log("install did not quit the app; relaunching on the current version");
			app.relaunch();
			app.exit(0);
		}, INSTALL_QUIT_GRACE_MS),
	};
	quitRequested = true;
	// From here an updater error is the install's (T3's install action, which owns its recovery).
	activeAction = "install";
	try {
		// Silent, and run the new version after (T3's quitAndInstall, DesktopUpdates.ts:930-933):
		// NSIS shows no installer window and always relaunches.
		autoUpdater.quitAndInstall(true, true);
	} catch (err) {
		log(`quitAndInstall failed: ${err?.message ?? err}`);
		recoverFailedInstall();
	}
}

/* ── Update everything (roadmap item 23 PR 2, electron/update-everything.cjs) ──
 * One pinned version for the whole run: never a newer one picked at install. */

// The run in progress, for the guards below (set once the server list exists).
let updateEverything = null;
const updateActions = createUpdateActions({
	updater: () => autoUpdater,
	state: () => updateState,
	// The menu's check is main's own (the sidebar's): its failure handling, and its { checked }.
	check: () => checkForUpdates(),
	activate: () => activateWindow(),
	// Every menu dialog's parent, read as it is about to show: the app window while it is alive and
	// shown (also for Update in progress and Updates unavailable, which restore nothing).
	appWindow: () => dialogParent(appWindow()),
	// A pinned download names its version from the start: electron-updater drops an older staged
	// download once it starts another, so the state no longer claims it.
	downloadStarted: (version) => {
		const notes = offeredNotes();
		const offered = updateState.availableVersion === version && updateState.downloadedVersion === null
			? updateState
			: updateMachine.reduceOnUpdateAvailable({ ...updateState, downloadedVersion: null }, version, nowIso(), notes.releaseNotes, notes.omittedReleaseCount);
		setUpdateState(updateMachine.reduceOnDownloadStart(offered));
	},
	// Its failure offers it again with T3's download retry: nothing stays at 0%.
	downloadFailed: () => setUpdateState(updateMachine.reduceOnDownloadFailure(updateState, DOWNLOAD_FAILED)),
	installing: () => installing,
	startInstall: () => { installing = true; quitAndInstallNow(); },
	adoptNotes: (info) => adoptOfferedNotes(info),
	// Read when used: main.cjs loads before Electron's app is ready (and under test fakes).
	get appVersion() { return app.getVersion(); },
	compareVersions: releaseNotes.compareVersions,
	// `parent`: the app window the menu activated (focus arrives late on Linux and Windows). With
	// none, no parent at all: the focused window may be the Switch server… panel.
	show: (options, parent) => {
		const owner = dialogParent(parent);
		return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
	},
	// The menu's Download and Restart name the version their dialog showed: never another one.
	download: (version) => downloadUpdateNow({ expect: version }),
	install: (version) => installUpdateNow({ expect: version }),
	running: () => updateEverything?.running() ?? false,
	pinFeed: (version) => require("./nightly-updater.cjs").pinFeed(autoUpdater, version, { override: process.env.LH_UPDATE_FEED }),
	log,
});

const UPDATE_EVERYTHING_RESULT = () => path.join(app.getPath("userData"), "update-everything.json");

/** Main's side of electron/update-everything.cjs. */
function updateEverythingDeps(list) {
	const ask = (options) => {
		const parent = list.current()?.win;
		const settings = { type: "question", noLink: true, defaultId: 0, cancelId: options.buttons.length - 1, ...options };
		return (parent ? dialog.showMessageBox(parent, settings) : dialog.showMessageBox(settings)).then(({ response }) => response);
	};
	return {
		appVersion: app.getVersion(),
		updater: {
			state: () => (autoUpdater ? updateState : { ...updateState, status: "disabled" }),
			check: () => checkForUpdates(),
			download: downloadUpdateNow,
			pin: updateActions.pin,
			downloadPinned: updateActions.downloadPinned,
			downloadExact: updateActions.downloadExact,
			installPinned: updateActions.installPinned,
			install: () => installUpdateNow(),
		},
		selection: () => list.current(),
		// No protocol header: the server may come back speaking a newer one.
		request: (origin, pathname, { token, method = "GET", body, timeoutMs } = {}) => requestServer(origin, pathname, {
			token, method, protocol: false, ...(timeoutMs && { timeoutMs }),
			...(body && { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
		}),
		confirm: ask,
		tell: ({ message, detail }) => ask({ type: "info", message, detail, buttons: ["OK"] }),
		progress: (origin, text) => list.coverForUpdate(origin, text),
		fail: (origin, problem) => list.endUpdate(origin, problem),
		reconnect: (origin, version) => list.endUpdate(origin, null, { version }),
		saveResult: (record) => fs.writeFileSync(UPDATE_EVERYTHING_RESULT(), JSON.stringify(record), { mode: 0o600 }),
		takeResult: () => {
			let raw;
			try { raw = fs.readFileSync(UPDATE_EVERYTHING_RESULT(), "utf8"); } catch { return null; }
			try { fs.unlinkSync(UPDATE_EVERYTHING_RESULT()); } catch { /* read once anyway */ }
			return JSON.parse(raw);
		},
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
}

function setupAutoUpdater() {
	if (!app.isPackaged) {
		log("auto-update: dev build - updater disabled");
		setUpdateState({ ...updateState, status: "disabled" });
		return;
	}
	readInstallRecord();
	// In the first snapshot, so the launch's "did not apply" toast doesn't wait for a check.
	if (notAppliedVersion) setUpdateState({ ...updateState });
	try {
		autoUpdater = require("electron-updater").autoUpdater;
		const feed = process.env.LH_UPDATE_FEED;
		const { lhNightlyRepository } = require("../package.json");
		if (feed) {
			autoUpdater.setFeedURL({ provider: "generic", url: feed });
			log(`auto-update: LH_UPDATE_FEED override -> ${feed}`);
		} else if (lhNightlyRepository) {
			const { NightlyProvider } = require("./nightly-updater.cjs");
			autoUpdater.setFeedURL({ provider: "custom", updateProvider: NightlyProvider, repository: lhNightlyRepository });
		}
	} catch (err) {
		autoUpdater = null;
		log(`auto-update: electron-updater unavailable (${err?.message ?? err}) - updates disabled`);
		setUpdateState({ ...updateState, status: "disabled" });
		return;
	}
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;
	autoUpdater.fullChangelog = true;
	// Route every updater log line through the shell's own log (userData/
	// logs/main.log) - feed failures must be diagnosable after the fact.
	autoUpdater.logger = {
		info: (m) => log(`updater: ${m}`),
		warn: (m) => log(`updater warn: ${m}`),
		debug: (m) => {}, // too chatty for the persistent log
		error: (m) => log(`updater error: ${m}`),
	};
	// An offered, downloading or downloaded update stays on screen while a later check runs
	// (T3: "An offer stays on screen while re-checking", DesktopUpdates.ts:594-597), and so does a
	// failed download being retried from "error" (its Download re-checks first).
	const offering = () => updateMachine.isOffered(updateState) || updateState.status === "downloading" || updateMachine.hasDownloadableOffer(updateState);
	autoUpdater.on("checking-for-update", () => { if (!offering()) setUpdateState(updateMachine.reduceOnCheckStart(updateState, nowIso())); });
	autoUpdater.on("update-available", (info) => {
		// A later check must not hide a staged or downloading update (Install re-checks for newer itself).
		if (updateState.status === "downloaded" || updateState.status === "downloading" || typeof info?.version !== "string") return;
		// Found again: nothing changes (T3's handleUpdateAvailable, DesktopUpdates.ts:1080).
		if (updateMachine.isOffered(updateState) && updateState.availableVersion === info.version) return;
		adoptOfferedNotes(info);
		const notes = offeredNotes();
		setUpdateState(updateMachine.reduceOnUpdateAvailable(updateState, info.version, nowIso(), notes.releaseNotes, notes.omittedReleaseCount));
	});
	autoUpdater.on("download-progress", (progress) => {
		const percent = Number.isFinite(progress?.percent) ? Math.min(100, Math.max(0, progress.percent)) : null;
		if (shouldReportDownloadProgress(updateState, percent)) setUpdateState(updateMachine.reduceOnDownloadProgress(updateState, percent));
	});
	autoUpdater.on("update-not-available", () => { if (!offering()) setUpdateState(updateMachine.reduceOnNoUpdate(updateState, nowIso())); });
	autoUpdater.on("update-downloaded", (info) => {
		log(`update downloaded: ${info?.version} - pill shown`);
		if (typeof info?.version === "string") setUpdateState(updateMachine.reduceOnDownloadComplete(updateState, info.version));
	});
	autoUpdater.on("error", (err) => {
		log(`updater error: ${err?.message ?? err}`);
		// An install's error (electron-updater reports a failed installer here): T3's recovery, with no
		// generic error on top. A check or download of ours reports through its own promise, and a
		// later error must not hide an update already staged (as T3's check failure keeps it).
		if (activeAction === "install") { recoverFailedInstall(); return; }
		if (installing) return;
		if (activeAction || updateState.downloadedVersion) return;
		setUpdateState(updateMachine.reduceOnUpdaterError(updateState, UPDATE_FAILED, nowIso()));
	});
}

/** The app's own window: the server list's content window, or the dev shell's local one; never
 *  the Switch server… panel, a popup or any other window. */
function appWindow() {
	if (serverList) return serverList.appWindow();
	return [...trustedAppWindows].find((win) => !win.isDestroyed()) ?? null;
}

/** A window a menu dialog may sit on: alive and shown. A replacement window that exists but isn't
 *  shown yet (its first paint is pending) is still opening: no parent then. */
function dialogParent(win) {
	return win && !win.isDestroyed() && win.isVisible() ? win : null;
}

/** The menu's check shows its dialog over the app's window: restore and focus it, or start
 *  reopening it when it is gone, without waiting for a reconnect (T3's desktopWindow.activate,
 *  DesktopWindow.ts:1169-1189 at df09ced7, reveals its splash and returns). The window to
 *  parent the dialog on, or null while one is still opening. */
function activateWindow() {
	let win = appWindow();
	if (!win) {
		try {
			const opening = reopenWindow?.();
			if (opening && typeof opening.then === "function") opening.catch((err) => log(`menu reopen failed: ${err?.message ?? err}`));
		} catch (err) {
			log(`menu reopen failed: ${err?.message ?? err}`);
		}
		win = appWindow();
		if (!win) return null;
	}
	if (win.isMinimized()) win.restore();
	win.focus();
	return dialogParent(win);
}

function zoomStep(win, dir) {
	const current = win.webContents.getZoomFactor();
	const next =
		dir > 0
			? ZOOM_LADDER.find((f) => f > current + 0.001) ?? ZOOM_LADDER[ZOOM_LADDER.length - 1]
			: [...ZOOM_LADDER].reverse().find((f) => f < current - 0.001) ?? ZOOM_LADDER[0];
	applyZoom(win, next);
}

function applyZoom(win, factor) {
	factor = Math.min(2, Math.max(0.75, factor)); // ladder clamps; ⌘0 = 1
	win.webContents.setZoomFactor(factor);
	if (trustedAppWindows.has(win)) win.webContents.send("lh:zoom", factor);
}

/** macOS needs an application menu with the Edit roles — without one,
 *  Cmd+C/V/A do nothing in the renderer. Everything else stays minimal. */
function installMenu() {
	const template = [
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				// T3's native dialogs, in the local window and onto a server (revision PR 6). In every
				// platform's menu, unlike T3 (macOS only, DesktopApplicationMenu.ts:217-225 at df09ced7):
				// it is the way out when this app is too old to open its server, when there is no server
				// page, so no sidebar control or Settings (owner, 2026-11-18 and 2026-11-21).
				{ label: "Check for Updates…", click: () => { void updateActions.checkNatively(); } },
				...(serverList ? [{ label: "Switch server…", click: () => serverList.show({ check: true }) }] : []),
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				// OWNED zoom (see applyZoom): the roles change zoomLevel
				// silently; these broadcast the factor and re-seat the
				// traffic lights. The renderer's --lh-zoom depends on
				// hearing every change.
				{
					label: "Actual Size",
					accelerator: "CommandOrControl+0",
					click: () => { const win = BrowserWindow.getFocusedWindow(); if (win) applyZoom(win, 1); },
				},
				{
					label: "Zoom In",
					accelerator: "CommandOrControl+Plus",
					click: () => { const win = BrowserWindow.getFocusedWindow(); if (win) zoomStep(win, +1); },
				},
				{
					label: "Zoom Out",
					accelerator: "CommandOrControl+-",
					click: () => { const win = BrowserWindow.getFocusedWindow(); if (win) zoomStep(win, -1); },
				},
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{ role: "windowMenu" },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function startLocalServer(signal) {
	if (serverProcess?.connected && localOrigin) {
		chatgpt?.resume();
		subscriptions?.resume();
		return localOrigin;
	}
	const url = `http://127.0.0.1:${await freePort()}`;
	signal.throwIfAborted();
	desktopAPISecret = randomBytes(32).toString("hex");
	const ownedOrigin = new URL(url).origin;
	chatgpt = createChatGPT({
		store: fileStore(path.join(app.getPath("userData"), "chatgpt-credentials.json")),
		openExternal: (target) => shell.openExternal(target),
		onChange: (value) => {
			chatgptChild?.send(value);
			for (const win of trustedAppWindows) win.webContents.send("lh:chatgpt:changed");
		},
	});
	subscriptions = createSubscriptions({
		directory: app.getPath("userData"),
		loadSDK: () => loadSubscriptionSDK(path.dirname(serverEntry())),
		openExternal: (target) => shell.openExternal(target),
		onChange: (snapshot) => {
			subscriptionChild?.send(snapshot);
			for (const win of trustedAppWindows) win.webContents.send("lh:subscriptions:changed");
		},
	});
	await subscriptions.ready;
	signal.throwIfAborted();
	log(`starting server: ${serverEntry()}`);
	log(`data dir: ${DATA_DIR()}${fs.existsSync(AUTH_FILE()) ? " · auth.json: present" : " · auth.json: ABSENT (no BYOK keys yet)"}`);
	const child = await startServer(new URL(url).port);
	await waitUntilUp(url, child);
	log(`server up: ${url}`);
	const token = await exchangeDesktopSession(ownedOrigin, desktopAPISecret);
	if (serverProcess !== child || !child.connected) throw new Error("Bundled server stopped before login completed.");
	desktopSessionToken = token;
	localOrigin = ownedOrigin;
	lastLocalOrigin = ownedOrigin;
	log("desktop session ready");
	return url;
}

async function main() {
	app.on("window-all-closed", () => {
		chatgpt?.pause();
		subscriptions?.pause();
		// macOS convention: the app stays resident, reactivated from the Dock.
		if (process.platform !== "darwin") app.quit();
	});

	// The child must not outlive us — cover every quit path.
	app.on("before-quit", () => { serverList?.close(); void killServer(); });
	process.on("exit", killServer);
	process.on("SIGHUP", killServer);

	await app.whenReady();

	// Read the same record/custom theme the server uses before constructing
	// any native window, including the external development shell.
	appearance = readAppearance(serverDataDir({
		devUrl: process.env.LH_DEV_URL, env: process.env,
		packagedDataDir: DATA_DIR(), repoRoot: path.join(__dirname, ".."),
	}));
	nativeTheme.themeSource = themeSourceFor(appearance.mode);

	// Dev mode: point at a running `next dev` server (LH_DEV_URL) — no
	// spawn, no packaging, full HMR. The rest of this shell still applies
	// (guards, menu, single instance).
	const devUrl = process.env.LH_DEV_URL;
	if (devUrl) {
		log(`dev mode: ${devUrl} — waiting for server`);
		const { waitForDevServer } = require("./dev-server-readiness.cjs");
		const startup = new AbortController();
		const cancelStartup = () => startup.abort(new Error("Development startup cancelled by application quit"));
		app.once("before-quit", cancelStartup);
		try {
			await waitForDevServer(devUrl, { signal: startup.signal });
			if (startup.signal.aborted) return;
			log(`dev server ready: ${devUrl}`);
		} catch (error) {
			if (!startup.signal.aborted) {
				log(`dev server startup failed: ${error?.message ?? error}`);
				app.exit(1);
			}
			return;
		} finally {
			app.removeListener("before-quit", cancelStartup);
		}
		localOrigin = new URL(devUrl).origin;
	}

	// Renderer controls contain no token/URL/code operation. The separate server
	// child is the only recipient of credential leases over inherited IPC.
	ipcMain.handle("lh:chatgpt:control", async (event, command) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) return { error: "Untrusted desktop request." };
		if (!chatgpt || !serverProcess?.connected) return { available: false, pending: false, activeId: null, accounts: [], error: "ChatGPT sign-in requires the desktop app's private server connection. Browser-only and externally launched development servers keep API-key connections." };
		return chatGPTControl(command, chatgpt);
	});

	ipcMain.handle("lh:subscriptions:control", async (event, command) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		if (!subscriptions || !serverProcess?.connected) {
			if (command?.op === "status") return [];
			throw new Error("Subscription sign-in requires the desktop app's private server connection.");
		}
		return subscriptionControl(command, subscriptions);
	});

	// The dev shell has no browser tabs. Only a one-use action on its own
	// Next server may be resolved here; never accept an arbitrary external URL.
	ipcMain.handle("lh:subscriptions:web-browser", async (event, action) => {
		if (!devUrl || !trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) throw new Error("Untrusted development request.");
		await openWebSubscriptionBrowser(action, localOrigin, { openExternal: (target) => shell.openExternal(target) });
	});

	ipcMain.handle("lh:attachment:pick", (event, mode) => pickAttachmentPath(event, mode, {
		BrowserWindow, dialog, trustedAppWindows, origin: localOrigin,
	}));

	// Auto-update: wire the updater before the window so the pill's
	// channel is live from first paint; the first check (15 s after launch)
	// and the 4h interval are scheduled after it below. setupAutoUpdater's contract: failures
	// are log lines — this can never block boot.
	setupAutoUpdater();
	// Answers whether main took the install, so the page shows "Restarting" only when it did.
	ipcMain.handle("lh:update-install", (event, source) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		const accepted = installAccepted();
		void installUpdateNow({ fromSidebar: source === "sidebar" });
		return accepted;
	});
	ipcMain.handle("lh:update:download", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		// Re-checks, then downloads; resolves T3's { accepted, completed } with the state for the toasts.
		return downloadUpdateNow().then((result) => ({ ...result, state: updateState }));
	});
	ipcMain.handle("lh:update:get", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		return updateState;
	});
	// The page claims a notice, then acks it once shown (main owns "once"; see claimUpdateNotice).
	// Also from a window still on the last local origin when the server's restart failed.
	const noticeSender = (event) => trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) && trustedSender(event, localOrigin ?? lastLocalOrigin, BrowserWindow);
	ipcMain.handle("lh:update:claim-notice", (event, key) => {
		if (!noticeSender(event)) throw new Error("Untrusted desktop request.");
		return claimUpdateNotice(key, event.sender);
	});
	ipcMain.handle("lh:update:ack-notice", (event, key) => {
		if (!noticeSender(event)) throw new Error("Untrusted desktop request.");
		return ackUpdateNotice(key, event.sender);
	});
	ipcMain.handle("lh:update:check", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		// T3's { checked } with the state, once the check ends: the sidebar's toast reads it.
		return checkForUpdates().then((result) => ({ ...result, state: updateState }));
	});

	// Sidebar-at-narrow-window (owner, 2026-09-17): the renderer auto-closes
	// the sidebar below SIDEBAR_AUTOCLOSE (928px); opening it again at that
	// width asks the window to widen instead — the layout never has to
	// accommodate a narrow window + open sidebar. Top-left stays fixed, the
	// window grows right. No-op when already wide.
	// The renderer's first paint can race did-finish-load — it asks for
	// the current factor itself (mirrors "lh:zoom" pushes).
	ipcMain.handle("lh:zoom:get", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		return event.sender.getZoomFactor();
	});
	ipcMain.on("lh:expand-window", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!trustedAppWindows.has(win) || !trustedSender(event, localOrigin, BrowserWindow)) return;
		const { x, y, width, height } = win.getBounds();
		const target = SIDEBAR_AUTOCLOSE;
		if (width < target) win.setBounds({ x, y, width: target, height });
	});
	// The renderer reports every appearance write (and the record on load):
	// the chrome follows without a restart.
	ipcMain.on("lh:appearance", (event, next) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) return;
		appearance = normalizeAppearance(next);
		nativeTheme.themeSource = themeSourceFor(appearance.mode);
		for (const win of trustedAppWindows) applyChrome(win);
	});
	if (devUrl) {
		installMenu();
		reopenWindow = () => createWindow(devUrl).win;
		reopenWindow();
	} else {
		// Packaged localhost requests keep their own bootstrap. Remote windows
		// use separate sessions and never receive the local preload.
		session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
			callback({ requestHeaders: desktopAPIHeaders(details, localOrigin, desktopSessionToken, [...trustedAppWindows]) });
		});
		serverList = await createServerList({
			app, BrowserWindow, WebContentsView, ipcMain, session, shell, safeStorage, dialog,
			startLocal: startLocalServer, stopLocal: killServer, createLocalWindow: () => createWindow(),
			setLocalMenu: () => installMenu(), themeMode: () => appearance.mode,
			updatingServer: () => updateEverything?.server() ?? null,
		});
		installMenu();
		reopenWindow = () => serverList.reopen();
		updateEverything = createUpdateEverything(updateEverythingDeps(serverList));
		registerDesktopUpdateIPC(ipcMain, { current: () => serverList.current(), updateEverything });
		registerChatGPTSignInIPC(ipcMain, {
			current: () => serverList.current(), signIn: (accountId) => serverList.chatgptSignIn(accountId), cancel: () => serverList.chatgptCancel(),
		});
		const relaunch = updateEverything.takeLaunch();
		await serverList.launch({ server: relaunch?.server });
		// The app update didn't apply: offer the app-only retry of that same version.
		void updateEverything.afterLaunch(relaunch);
	}
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) reopenWindow();
	});
	// Startup (15 s) + 4h checks stay main-owned, with no toggle. No renderer
	// subscription is required; late loads retrieve the snapshot.
	if (autoUpdater) {
		setTimeout(() => checkForUpdates(), UPDATE_STARTUP_DELAY_MS);
		setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
	}
}