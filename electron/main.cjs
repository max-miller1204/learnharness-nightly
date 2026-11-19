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
let chatgpt = null;
let chatgptChild = null;
let subscriptions = null;
let subscriptionChild = null;
// Per-launch secret, traded once for a desktop login session (never renderer state).
let desktopAPISecret = null;
let desktopSessionToken = null;
let reopenWindow = null;
let localOrigin = null;
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
// Observational only: this snapshot NEVER gates a check, download or install.
// The revision lets late subscribers reject an older in-flight IPC snapshot.
// `downloadPercent` (0 to 100, or null when unknown) only while "downloading": the sidebar's progress ring.
let updateState = { status: "idle", version: null, revision: 0, downloadPercent: null, releaseNotes: [], omittedReleaseCount: 0 };
// Every group of the offered version (uncapped): the notes cache keeps them all.
let offeredGroups = [];
let installing = false;

function reportUpdateStatus(status, version = null, downloadPercent = null) {
	try {
		// A later check/error must not hide an update already staged.
		if (updateState.status === "downloaded" && status !== "downloaded") return;
		const keepsNotes = status === "available" || status === "downloading" || status === "downloaded";
		const notes = keepsNotes ? releaseNotes.capGroups(offeredGroups) : { releaseNotes: [], omittedReleaseCount: 0 };
		const percent = status === "downloading" && Number.isFinite(downloadPercent) ? Math.min(100, Math.max(0, downloadPercent)) : null;
		updateState = { status, version: typeof version === "string" ? version : null, revision: updateState.revision + 1, downloadPercent: percent, ...notes };
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

/** Read the SAME data directory passed to the packaged server. Only an
 * explicit false opts out; absent/corrupt/unreadable settings keep checks ON.
 * Re-read for each automatic check so saving the toggle needs no restart. */
function automaticUpdatesEnabled() {
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR(), "settings.json"), "utf8"));
		return settings?.general?.autoUpdate !== false;
	} catch {
		return true;
	}
}

function checkForUpdates({ manual = false } = {}) {
	if (!autoUpdater) return;
	if (!manual && !automaticUpdatesEnabled()) {
		log("auto-update: automatic check skipped (turned off in Settings)");
		return;
	}
	// Do not gate on display state: a stale spinner/error must never disable
	// future background checks. electron-updater owns its in-flight work.
	autoUpdater
		.checkForUpdates()
		.then((result) => {
			// A declined check (e.g. an unsupported package) establishes no
			// latest-version claim. Real results arrive through updater events.
			if (!result) reportUpdateStatus("idle");
		})
		.catch((err) => {
			log(`update check failed: ${err?.message ?? err}`);
			reportUpdateStatus("error");
		});
}

/** Download the offered version (the user clicked Download). */
function downloadUpdateNow() {
	if (!autoUpdater || updateState.status !== "available" || updateEverything?.running()) return;
	// 0 at the start, like T3's reduceDesktopUpdateStateOnDownloadStart (updateMachine.ts:145-156 at 3ce21458).
	reportUpdateStatus("downloading", updateState.version, 0);
	autoUpdater.downloadUpdate().catch((err) => {
		log(`update download failed: ${err?.message ?? err}`);
		reportUpdateStatus("error");
	});
}

// A quitAndInstall that does not quit (a cancelled admin prompt, a missing
// installer) leaves the app without its server: relaunch onto the old version.
const INSTALL_QUIT_GRACE_MS = 10 * 1000;

/** The user confirmed Install: re-check, take a newer build if one appeared, then quit and install. */
async function installUpdateNow() {
	// An Update everything run owns its pinned install (electron/update-everything.cjs).
	if (!autoUpdater || installing || updateState.status !== "downloaded" || updateEverything?.running()) return;
	installing = true;
	const downloaded = updateState.version;
	let offered = null;
	try {
		const result = await autoUpdater.checkForUpdates();
		const version = result?.updateInfo?.version;
		if (typeof version === "string" && typeof downloaded === "string" && releaseNotes.compareVersions(version, downloaded) > 0) offered = result.updateInfo;
	} catch (err) {
		// A failed re-check (feed unreachable) installs what is already downloaded.
		log(`install re-check failed: ${err?.message ?? err}; installing ${downloaded}`);
	}
	if (offered) {
		log(`install: ${offered.version} is newer than the downloaded ${downloaded}; downloading it first`);
		adoptOfferedNotes(offered);
		try {
			await autoUpdater.downloadUpdate();
		} catch (err) {
			// electron-updater empties its cache when it starts a different version,
			// so the old download is gone: install nothing, offer the newer one again.
			log(`install: downloading ${offered.version} failed (${err?.message ?? err}); nothing installed`);
			installing = false;
			updateState = { ...updateState, status: "available" };
			reportUpdateStatus("available", offered.version);
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
	// Kill the server BEFORE the quit-and-install (see block comment).
	try {
		killServer();
	} catch {
		/* already dead */
	}
	let quitting = false;
	const markQuitting = () => { quitting = true; };
	app.once("before-quit", markQuitting);
	try {
		autoUpdater.quitAndInstall();
	} catch (err) {
		log(`quitAndInstall failed: ${err?.message ?? err}`);
	}
	setTimeout(() => {
		if (quitting) return;
		app.removeListener("before-quit", markQuitting);
		installing = false;
		log("install did not quit the app; relaunching on the current version");
		app.relaunch();
		app.exit(0);
	}, INSTALL_QUIT_GRACE_MS);
}

/* ── Update everything (roadmap item 23 PR 2, electron/update-everything.cjs) ──
 * One pinned version for the whole run: never a newer one picked at install. */

// The run in progress, for the guards below (set once the server list exists).
let updateEverything = null;
const updateActions = createUpdateActions({
	updater: () => autoUpdater,
	state: () => updateState,
	offerAgain: (version) => {
		updateState = { ...updateState, status: "available" };
		reportUpdateStatus("available", version);
	},
	report: (status) => reportUpdateStatus(status),
	downloadStarted: (version) => reportUpdateStatus("downloading", version, 0),
	installing: () => installing,
	startInstall: () => { installing = true; quitAndInstallNow(); },
	adoptNotes: (info) => adoptOfferedNotes(info),
	// Read when used: main.cjs loads before Electron's app is ready (and under test fakes).
	get appVersion() { return app.getVersion(); },
	compareVersions: releaseNotes.compareVersions,
	show: (options) => {
		const parent = BrowserWindow.getFocusedWindow();
		return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
	},
	download: () => downloadUpdateNow(),
	install: () => installUpdateNow(),
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
			check: () => checkForUpdates({ manual: true }),
			download: downloadUpdateNow,
			pin: updateActions.pin,
			downloadPinned: updateActions.downloadPinned,
			downloadExact: updateActions.downloadExact,
			installPinned: updateActions.installPinned,
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
		reportUpdateStatus("disabled");
		return;
	}
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
		reportUpdateStatus("disabled");
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
	// An offered or downloading update stays on screen while a later check runs.
	const offering = () => updateState.status === "available" || updateState.status === "downloading";
	autoUpdater.on("checking-for-update", () => { if (!offering()) reportUpdateStatus("checking"); });
	autoUpdater.on("update-available", (info) => {
		if (updateState.status === "downloaded" || updateState.status === "downloading") return;
		adoptOfferedNotes(info);
		reportUpdateStatus("available", info?.version);
	});
	autoUpdater.on("download-progress", (progress) => {
		const percent = Number.isFinite(progress?.percent) ? progress.percent : null;
		if (shouldReportDownloadProgress(updateState, percent)) reportUpdateStatus("downloading", updateState.version, percent);
	});
	autoUpdater.on("update-not-available", () => { if (!offering()) reportUpdateStatus("up-to-date"); });
	autoUpdater.on("update-downloaded", (info) => {
		log(`update downloaded: ${info?.version} - pill shown`);
		reportUpdateStatus("downloaded", info?.version);
	});
	autoUpdater.on("error", (err) => {
		log(`updater error: ${err?.message ?? err}`);
		if (!installing) reportUpdateStatus("error");
	});
}

/** One result surface for manual checks. Preload buffers the navigation
 * request until React subscribes, including when all macOS windows closed. */
async function checkForUpdatesFromMenu() {
	try {
		const win = [...trustedAppWindows][0] ?? await reopenWindow?.();
		if (trustedAppWindows.has(win)) {
			if (win.isMinimized()) win.restore();
			win.focus();
			const openSettings = () => {
				try { win.webContents.send("lh:open-settings", "general"); } catch { /* window closed */ }
			};
			if (win.webContents.isLoadingMainFrame()) win.webContents.once("did-finish-load", openSettings);
			else openSettings();
		}
	} catch {
		/* Navigation failure must not prevent the manual check. */
	}
	checkForUpdates({ manual: true });
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
function installMenu({ local = true } = {}) {
	const template = [
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				// Manual checks report their result in Settings → General.
				// Connected to a server there is no local Settings page: native dialogs instead,
				// also the way out when this app is too old to open the server (owner, 2026-11-18).
				{ label: "Check for Updates…", click: () => (local ? checkForUpdatesFromMenu() : updateActions.checkNatively()) },
				...(serverList ? [{ label: "Switch server…", click: () => serverList.show() }] : []),
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
	ipcMain.on("lh:update-install", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) return;
		void installUpdateNow();
	});
	ipcMain.handle("lh:update:download", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		downloadUpdateNow();
	});
	ipcMain.handle("lh:update:get", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		return updateState;
	});
	ipcMain.handle("lh:update:check", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, localOrigin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		checkForUpdates({ manual: true });
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
			app, BrowserWindow, WebContentsView, ipcMain, session, shell, safeStorage,
			startLocal: startLocalServer, stopLocal: killServer, createLocalWindow: () => createWindow(),
			setLocalMenu: (enabled) => installMenu({ local: enabled }), themeMode: () => appearance.mode,
		});
		installMenu({ local: false });
		reopenWindow = () => serverList.reopen();
		updateEverything = createUpdateEverything(updateEverythingDeps(serverList));
		registerDesktopUpdateIPC(ipcMain, { current: () => serverList.current(), updateEverything });
		const relaunch = updateEverything.takeLaunch();
		await serverList.launch({ server: relaunch?.server });
		// The app update didn't apply: offer the app-only retry of that same version.
		void updateEverything.afterLaunch(relaunch);
	}
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) reopenWindow();
	});
	// Startup (15 s) + 4h checks stay main-owned and read the current
	// preference. No renderer subscription is required; late loads retrieve
	// the snapshot.
	if (autoUpdater) {
		setTimeout(() => checkForUpdates(), UPDATE_STARTUP_DELAY_MS);
		setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
	}
}