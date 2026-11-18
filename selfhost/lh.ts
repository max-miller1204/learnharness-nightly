/**
 * `lh`: the LearnHarness self-hosting launcher and CLI (the `t3` CLI's
 * service half, for LearnHarness). Run by the bundled Node 26 straight from
 * TypeScript (type stripping). Node built-ins only.
 *
 *   lh up | pair | status | update [--now] | rollback | use <version> | restart
 *   lh restore <backup> | versions | logs [server|service|update] [-f]
 *   lh preview <PR> [--port N]
 *   lh down | uninstall [--keep-data] | help
 *
 * Internal: __service (the systemd entry point), __install, __selftest,
 * __selftest-launcher.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { CLI_SESSION_TTL_MS, createPairingLink, formatCode, issueSession, pairingUrl, revokeSession } from "./src/auth-store.ts";
import { freeBytes, listBackups, pruneBackups, restore, snapshot, spaceForSnapshot } from "./src/backup.ts";
import { buildChildEnv, detectChrome, readConfig, readServiceEnv, writeConfig, type LhConfig } from "./src/config.ts";
import { appendLog, boundLog, LOG_CHECK_INTERVAL_MS } from "./src/logs.ts";
import { clearMarker, lockIsHeld, markerExists, tryAcquireLock, writeMarker, type Lock } from "./src/locks.ts";
import { layout, lhHome, serviceName, versionPaths } from "./src/paths.ts";
import { LAUNCHER_PROTOCOL } from "./src/protocol.ts";
import {
	compareVersions,
	currentArch,
	DEFAULT_FEED_URL,
	fetchLatest,
	installedVersions,
	isExactVersion,
	isInstalled,
	readState,
	stageVersion,
	writeFileDurably,
	writeState,
	type ServiceState,
} from "./src/release.ts";
import { fetchHealth, readVersionProtocol, selftestLauncher, spawnServerChild } from "./src/server.ts";
import { enableLinger, hasSystemd, lingerEnabled, repointService, shimPath, systemctl, unitPath, writeShim, writeUnit } from "./src/service.ts";
import { Supervisor, type UpdateRequestMarker } from "./src/supervisor.ts";
import { serveOff, serveOn, tailscaleAvailable, tailscaleSelf } from "./src/tailscale.ts";
import { pruneVersions } from "./src/versions.ts";
import { parsePrNumber, previewConfig, previewFeedUrl, previewHome, previewLockPath, previewServeMarker } from "./src/preview.ts";
import { QrCode } from "./src/qr.ts";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The version folder this launcher runs from (versions/<v>/selfhost/lh.ts), or "dev". */
const RUNNING_VERSION = (() => {
	const versionDirName = path.basename(path.dirname(SELF_DIR));
	return isExactVersion(versionDirName) ? versionDirName : "dev";
})();

// ---------------------------------------------------------------------------
// small helpers

type Flags = { _: string[]; [name: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Flags {
	const flags: Flags = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg.startsWith("--no-")) flags[arg.slice(5)] = false;
		else if (arg.startsWith("--")) {
			const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
			const next = argv[i + 1];
			if (inline !== undefined) flags[name] = inline;
			else if (next !== undefined && !next.startsWith("-") && ["port", "tailscale-port", "chrome-path", "expect-version", "feed-url", "label"].includes(name)) { flags[name] = next; i++; }
			else flags[name] = true;
		} else if (arg === "-f") flags.follow = true;
		else if (arg === "-y") flags.yes = true;
		else flags._.push(arg);
	}
	return flags;
}

const out = (line = "") => process.stdout.write(`${line}\n`);
const fail = (message: string): never => {
	process.stderr.write(`lh: ${message}\n`);
	process.exit(1);
};

/** Interactive question. Without a terminal, or with --yes, the default answer is taken. */
async function ask(question: string, fallback: boolean, flags: Flags): Promise<boolean> {
	if (flags.yes === true || !process.stdin.isTTY) return fallback;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
		return answer === "" ? fallback : answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

function requireState(home: string): ServiceState {
	const state = readState(home);
	if (!state) fail(`No LearnHarness install found in ${home}. Install it with the one-line installer (docs/self-hosting.md).`);
	return state as ServiceState;
}

function writeRequest(home: string, request: UpdateRequestMarker): void {
	writeFileDurably(layout(home).updateRequest, `${JSON.stringify(request, null, 2)}\n`);
}

function readRequest(home: string): UpdateRequestMarker | undefined {
	const file = layout(home).updateRequest;
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		fs.rmSync(file, { force: true });
		if (typeof raw.targetVersion !== "string" || !isExactVersion(raw.targetVersion)) return undefined;
		return {
			targetVersion: raw.targetVersion,
			...(typeof raw.restoreBackup === "string" ? { restoreBackup: raw.restoreBackup } : {}),
			...(raw.allowBad === true ? { allowBad: true } : {}),
			...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
		};
	} catch {
		fs.rmSync(file, { force: true });
		return undefined;
	}
}

async function health(config: LhConfig) {
	try { return await fetchHealth(config.port); } catch { return undefined; }
}

function urls(config: LhConfig): string[] {
	const list = [`http://127.0.0.1:${config.port}`];
	if (config.tailscale.enabled && config.tailscale.hostname) list.push(`https://${config.tailscale.hostname}:${config.tailscale.port}`);
	return list;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

function portFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// pairing (docs/specs/login-pairing.md)

/** T3's renderTerminalQrCode: two QR rows per line with half-block characters. */
function terminalQr(value: string, margin = 2): string {
	const qr = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
	const dark = (x: number, y: number) => x >= 0 && x < qr.size && y >= 0 && y < qr.size && qr.getModule(x, y);
	const rows: string[] = [];
	for (let y = -margin; y < qr.size + margin; y += 2) {
		let row = "";
		for (let x = -margin; x < qr.size + margin; x++) {
			const top = dark(x, y);
			const bottom = dark(x, y + 1);
			row += top ? (bottom ? "\u2588" : "\u2580") : bottom ? "\u2584" : " ";
		}
		rows.push(row);
	}
	return rows.join("\n");
}

/** Write a one-time link into the server's store and print it (works with the server stopped). */
function printPairingLink(home: string, config: LhConfig, label?: string): { local: string } {
	const link = createPairingLink(layout(home).data, label ? { label } : {});
	const local = pairingUrl(`http://127.0.0.1:${config.port}`, link.code);
	const tailnet = config.tailscale.enabled && config.tailscale.hostname
		? pairingUrl(`https://${config.tailscale.hostname}:${config.tailscale.port}`, link.code)
		: undefined;
	const primary = tailnet ?? local;
	const expires = new Date(link.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	out(`Pair a device: open this link, or scan the code below.`);
	out(`  ${primary}`);
	out(terminalQr(primary));
	if (tailnet) out(`On this machine: ${local}`);
	out(`Code: ${formatCode(link.code)} (one-time, expires at ${expires}). One code works in every link above.`);
	return { local };
}

const isWsl = () => {
	try { return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8")); } catch { return false; }
};

/** Open a URL in this machine's browser when there is a desktop session. */
function openInBrowser(url: string): boolean {
	if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !isWsl()) return false;
	const opened = spawnSync("sh", ["-c", "command -v xdg-open"], { encoding: "utf8" });
	if (opened.status !== 0) return false;
	const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
	child.on("error", () => { /* best effort */ });
	child.unref();
	return true;
}

async function pairCommand(flags: Flags): Promise<void> {
	const home = lhHome();
	requireState(home);
	printPairingLink(home, readConfig(home), typeof flags.label === "string" ? flags.label : undefined);
}

/** `lh update` calls /api/updates/*, so it writes itself a hidden 5 minute session. */
async function withCliSession<T>(home: string, fn: (authorization: string) => Promise<T>): Promise<T> {
	const dataDir = layout(home).data;
	const { token, session } = issueSession(dataDir, { method: "cli", hidden: true, ttlMs: CLI_SESSION_TTL_MS, client: { label: "lh", deviceType: "unknown" } });
	try {
		return await fn(`Bearer ${token}`);
	} finally {
		try { revokeSession(dataDir, session.id); } catch { /* it expires on its own */ }
	}
}

/** The backup taken when switching away from `version` most recently, if any. */
function backupFrom(home: string, version: string): string | undefined {
	return listBackups(home).filter((dir) => path.basename(dir).startsWith(`${version}-`)).at(-1);
}

// ---------------------------------------------------------------------------
// __service: the systemd entry point

async function acquireHomeLock(lockPath: string): Promise<Lock> {
	const deadline = Date.now() + 2 * 60_000;
	for (;;) {
		const lock = tryAcquireLock(lockPath);
		if (lock) return lock;
		if (Date.now() > deadline) fail("Another LearnHarness launcher still runs for this home.");
		await sleep(500);
	}
}

async function runService(): Promise<void> {
	const home = lhHome();
	const dirs = layout(home);
	fs.mkdirSync(dirs.logs, { recursive: true });
	const log = (line: string) => {
		process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
		if (line.includes("Update") || line.includes("update") || line.includes("Trial") || line.includes("rolled back") || line.includes("committed")) appendLog(dirs.updateLog, line);
	};
	for (const file of [dirs.serviceLog, dirs.serverLog, dirs.updateLog]) boundLog(file);
	setInterval(() => { for (const file of [dirs.serviceLog, dirs.serverLog, dirs.updateLog]) boundLog(file); }, LOG_CHECK_INTERVAL_MS).unref();

	const lock = await acquireHomeLock(dirs.launcherLock);
	clearMarker(dirs.stopMarker);
	clearMarker(dirs.restartPending);
	const state = readState(home);
	if (!state) {
		log(`[launcher] No install state in ${dirs.state}. Run the installer first.`);
		lock.close();
		process.exit(1);
	}
	const request = readRequest(home);
	const config = readConfig(home);
	const ignored = new Set<string>();
	const serviceEnv = (() => {
		try { return readServiceEnv(home); } catch (error) { log(`[launcher] Ignoring unreadable ${dirs.serviceEnv}: ${String(error)}`); return {}; }
	})();

	const supervisor = new Supervisor({
		home,
		readState: () => requireState(home),
		writeState: (next) => writeState(home, next),
		isInstalled: (version) => isInstalled(home, version),
		spawnChild: (version, role, trialUpdateId) => spawnServerChild(home, version, role, buildChildEnv({
			home,
			config,
			serviceEnv,
			...(trialUpdateId ? { trialUpdateId } : {}),
			onIgnored: (name) => {
				if (ignored.has(name)) return;
				ignored.add(name);
				log(`[launcher] service.env tried to set ${name}, which the launcher manages; ignored.`);
			},
		})),
		health: async () => fetchHealth(config.port),
		freeBytes,
		spaceForSnapshot: () => spaceForSnapshot(home),
		snapshot: (name) => snapshot(home, name),
		restore: (dir) => restore(home, dir),
		repoint: (version) => repointService(home, version),
		prune: (next) => {
			pruneVersions(home, [next.activeVersion, next.previousVersion, next.update?.status === "pending" ? next.update.targetVersion : undefined]);
			pruneBackups(home, 3, next.update?.backup ? [next.update.backup] : []);
		},
		minLauncherProtocolOf: (version) => readVersionProtocol(home, version).minLauncherProtocol,
		selftestLauncher: async (version) => selftestLauncher(home, version),
		dataFolderFree: () => !lockIsHeld(path.join(dirs.data, ".server.lock")),
		log,
		now: () => Date.now(),
		setTimeout: (cb, ms) => setTimeout(cb, ms),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		exit: (code) => { lock.close(); process.exit(code); },
		runningLauncherVersion: RUNNING_VERSION,
	});

	let stopping = false;
	const onSignal = (signal: string) => {
		if (stopping) return;
		stopping = true;
		// Synchronously, before the child is told to stop (T3's stop marker).
		writeMarker(dirs.stopMarker, `${signal}\n`);
		void supervisor.stop().finally(() => { lock.close(); process.exit(0); });
	};
	process.on("SIGTERM", () => onSignal("SIGTERM"));
	process.on("SIGINT", () => onSignal("SIGINT"));
	setInterval(() => { /* keep the event loop alive between children */ }, 1 << 30);
	await supervisor.start(request);
}

// ---------------------------------------------------------------------------
// self-tests

/** A newer launcher proves it loads and can read this home before taking over. */
function selftestLauncherCommand(): void {
	const home = lhHome();
	const state = readState(home);
	void lockIsHeld(layout(home).launcherLock);
	out(`ok launcher protocol ${LAUNCHER_PROTOCOL}${state ? `, active ${state.activeVersion}` : ""}`);
}

/** CI archive smoke: boot this archive's server with its bundled Node in a throwaway home. */
async function selftestArchive(flags: Flags): Promise<void> {
	const root = path.dirname(SELF_DIR);
	const node = path.join(root, "node", "bin", "node");
	const entry = path.join(root, "server", "server.js");
	for (const file of [node, entry]) if (!fs.existsSync(file)) fail(`archive is missing ${file}`);
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-selftest-"));
	const auth = path.join(temp, "auth.json");
	fs.writeFileSync(auth, "{}\n");
	const port = await freePort();
	const child = spawn(node, [entry], {
		cwd: path.dirname(entry),
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: temp, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port), LH_DATA_DIR: path.join(temp, "data"), LH_AUTH_FILE: auth, NEXT_TELEMETRY_DISABLED: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
	child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
	let exited = false;
	child.once("exit", () => { exited = true; });
	const finish = (code: number, message: string) => {
		if (!exited) child.kill("SIGKILL");
		fs.rmSync(temp, { recursive: true, force: true });
		if (code !== 0) process.stderr.write(`${output.slice(-4000)}\n`);
		(code === 0 ? out : (m: string) => process.stderr.write(`${m}\n`))(message);
		process.exit(code);
	};
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (exited) finish(1, "selftest: the server exited during boot");
		const h = await fetchHealth(port, 3_000).catch(() => undefined);
		if (h?.ok) {
			const page = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
			if (!page?.ok) finish(1, `selftest: GET / answered ${page?.status ?? "nothing"}`);
			const expected = typeof flags["expect-version"] === "string" ? flags["expect-version"] : undefined;
			if (expected && h.version !== expected) finish(1, `selftest: /api/health reports version ${h.version ?? "(none)"}, expected ${expected}`);
			finish(0, `selftest ok: version ${h.version ?? "(unknown)"} on port ${port}`);
		}
		await sleep(500);
	}
	finish(1, "selftest: /api/health never answered within 120s");
}

// ---------------------------------------------------------------------------
// install + user commands

/** Called by install.sh from the freshly extracted version folder. */
async function installCommand(flags: Flags): Promise<void> {
	const home = lhHome();
	if (!isExactVersion(RUNNING_VERSION)) fail("__install must run from an installed version folder.");
	const version = RUNNING_VERSION;
	writeFileDurably(versionPaths(home, version).complete, `${version}\n`);
	const state = readState(home);
	if (!state) {
		writeState(home, { protocol: 1, activeVersion: version, badVersions: [] });
		writeShim(home, version);
		out(`Installed LearnHarness ${version} in ${home}.`);
		return;
	}
	if (state.activeVersion === version) {
		out(`LearnHarness ${version} is already installed.`);
		return;
	}
	writeRequest(home, { targetVersion: version, allowBad: flags.force === true, reason: "installer" });
	out(`Installed LearnHarness ${version}; it replaces ${state.activeVersion} on the next service start.`);
}

async function upCommand(flags: Flags): Promise<void> {
	const home = lhHome();
	const state = requireState(home);
	if (!hasSystemd()) fail("systemd (user services) is required. See docs/self-hosting.md.");
	const config = readConfig(home);
	if (typeof flags.port === "string") {
		const port = Number(flags.port);
		if (!Number.isInteger(port) || port <= 0 || port >= 65536) fail(`invalid --port ${flags.port}`);
		config.port = port;
	}
	if (typeof flags["tailscale-port"] === "string") config.tailscale.port = Number(flags["tailscale-port"]);
	if (typeof flags["chrome-path"] === "string") config.chromePath = flags["chrome-path"];
	if (typeof flags["feed-url"] === "string") config.feedUrl = flags["feed-url"];
	if (!config.chromePath) {
		const chrome = detectChrome();
		if (chrome) config.chromePath = chrome;
	}
	if (!config.chromePath) out("No Chrome or Chromium found. Demo verification stays off until you install one (e.g. `sudo apt install chromium`) or pass --chrome-path, then run `lh up` again.");

	let wantTailscale = config.tailscale.enabled;
	if (flags.tailscale === true) wantTailscale = true;
	else if (flags.tailscale === false) wantTailscale = false;
	else if (!config.tailscale.enabled && tailscaleAvailable()) {
		wantTailscale = await ask(`Expose LearnHarness on your tailnet with Tailscale Serve (HTTPS on port ${config.tailscale.port})?`, false, flags);
	}
	if (wantTailscale) {
		if (!tailscaleAvailable()) fail("tailscale is not installed or not running.");
		const self = tailscaleSelf();
		if (!self) fail("Could not read this machine's Tailscale name (`tailscale status --json`). Is Tailscale logged in?");
		const served = serveOn(config.tailscale.port, config.port);
		if (!served.ok) fail(`tailscale serve failed: ${served.output}`);
		config.tailscale = { enabled: true, port: config.tailscale.port, hostname: (self as { dnsName: string }).dnsName };
	} else if (config.tailscale.enabled) {
		serveOff(config.tailscale.port);
		config.tailscale = { enabled: false, port: config.tailscale.port };
	}
	writeConfig(home, config);
	writeUnit(home, state.activeVersion);
	writeShim(home, state.activeVersion);
	systemctl("daemon-reload");
	const running = systemctl("is-active", `${serviceName()}.service`).stdout.trim() === "active";
	if (running) {
		const ok = await ask("The service is running. Restart it now to apply these settings? Running agent turns will stop.", true, flags);
		if (ok) systemctl("restart", `${serviceName()}.service`);
	} else {
		const enabled = systemctl("enable", "--now", `${serviceName()}.service`);
		if (!enabled.ok) fail(`systemctl --user enable --now failed: ${enabled.stderr.trim()}`);
	}
	if (flags.linger !== false && !lingerEnabled()) {
		const linger = await ask("Keep LearnHarness running when you're logged out? (runs `loginctl enable-linger`)", true, flags);
		if (linger && !enableLinger()) out("Could not enable lingering; the service stops when you log out.");
	}
	out("");
	out(`LearnHarness ${state.activeVersion} is starting.`);
	for (const url of urls(config)) out(`  ${url}`);
	out("");
	const { local } = printPairingLink(home, config);
	if (config.tailscale.enabled) out("Only devices on your tailnet can reach the HTTPS address.");
	out("Pair another device with `lh pair`. Never turn on Tailscale Funnel.");
	if (process.stdout.isTTY && flags.open !== false) {
		// Wait for the server so the browser doesn't land on a refused connection.
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline && !(await health(config))?.ok) await sleep(1000);
		if (openInBrowser(local)) out("Opened the local link in your browser.");
	}
}

async function statusCommand(): Promise<void> {
	const home = lhHome();
	const state = requireState(home);
	const config = readConfig(home);
	const active = systemctl("is-active", `${serviceName()}.service`).stdout.trim() || "unknown";
	const h = await health(config);
	out(`Home:      ${home}`);
	out(`Service:   ${serviceName()}.service (${active})`);
	out(`Active:    ${state.activeVersion}`);
	if (state.previousVersion) out(`Previous:  ${state.previousVersion}`);
	const installed = installedVersions(home);
	out(`Installed: ${installed.join(", ") || "(none)"}`);
	if (state.badVersions.length) out(`Skipped:   ${state.badVersions.join(", ")} (failed to start)`);
	if (state.update) out(`Last update: ${state.update.fromVersion} -> ${state.update.targetVersion}: ${state.update.status}${state.update.reason ? ` (${state.update.reason})` : ""}`);
	if (markerExists(layout(home).restartPending)) {
		const next = fs.readFileSync(layout(home).restartPending, "utf8").trim();
		out(`Launcher:  the launcher from ${next || "the active version"} takes over at the next service restart (\`lh restart\`, never required).`);
	}
	if (h) {
		const update = h.update as { status?: string; version?: string | null; message?: string | null } | undefined;
		out(`Server:    ${h.ok ? "healthy" : "unhealthy"}${h.version ? `, version ${h.version}` : ""}, ${h.idle ? "idle" : "busy"}`);
		if (update?.status) out(`Updates:   ${update.status}${update.version ? ` ${update.version}` : ""}${update.message ? `: ${update.message}` : ""}`);
	} else {
		out("Server:    not answering");
	}
	for (const url of urls(config)) out(`URL:       ${url}`);
}

async function updateCommand(flags: Flags): Promise<void> {
	const home = lhHome();
	const state = requireState(home);
	const config = readConfig(home);
	const h = await health(config);
	if (h?.ok && h.selfhost) {
		const route = flags.now === true ? "install" : "check";
		const response = await withCliSession(home, (authorization) => fetch(`http://127.0.0.1:${config.port}/api/updates/${route}`, { method: "POST", headers: { Authorization: authorization } }));
		const body = (await response.json().catch(() => ({}))) as { status?: string; version?: string | null; message?: string | null };
		out(`${body.status ?? "unknown"}${body.version ? ` ${body.version}` : ""}${body.message ? `: ${body.message}` : ""}`);
		if (flags.now !== true && body.status === "downloaded") out("It installs when you click Install in the app, or run `lh update --now`.");
		return;
	}
	out("The server isn't answering; updating through the launcher.");
	const arch = currentArch() ?? fail("this platform has no self-hosted builds");
	const feed = await fetchLatest(config.feedUrl ?? DEFAULT_FEED_URL);
	if (compareVersions(feed.version, state.activeVersion) <= 0) { out(`Already on the newest version (${state.activeVersion}).`); return; }
	await stageVersion(home, feed, arch, { badVersions: state.badVersions });
	writeRequest(home, { targetVersion: feed.version, reason: "lh update" });
	systemctl("restart", `${serviceName()}.service`);
	out(`Switching to ${feed.version}. Follow it with \`lh logs update -f\`.`);
}

async function switchCommand(target: string, flags: Flags, label: string): Promise<void> {
	const home = lhHome();
	const state = requireState(home);
	if (!isInstalled(home, target)) fail(`Version ${target} isn't installed. Installed: ${installedVersions(home).join(", ")}`);
	if (target === state.activeVersion) { out(`Already running ${target}.`); return; }
	const backup = backupFrom(home, target);
	let restoreBackup: string | undefined;
	if (backup) {
		const restoreIt = await ask(`Also restore your data from just before ${target} was replaced (${path.basename(backup)})? This discards everything since.`, false, flags);
		if (restoreIt) restoreBackup = backup;
	}
	writeRequest(home, { targetVersion: target, allowBad: true, reason: label, ...(restoreBackup ? { restoreBackup } : {}) });
	const restarted = systemctl("restart", `${serviceName()}.service`);
	if (!restarted.ok) fail(`systemctl --user restart failed: ${restarted.stderr.trim()}`);
	out(`Switching to ${target}${restoreBackup ? " and restoring your data" : ""}. Follow it with \`lh logs update -f\`.`);
}

async function restoreCommand(name: string | undefined, flags: Flags): Promise<void> {
	const home = lhHome();
	requireState(home);
	const all = listBackups(home);
	if (!name) {
		out(all.length ? all.map((dir) => path.basename(dir)).join("\n") : "No backups.");
		return;
	}
	const dir = all.find((d) => path.basename(d) === name || d === name) ?? fail(`No backup named ${name}. Run \`lh restore\` to list them.`);
	if (flags.yes !== true && !(await ask(`Replace your current data with ${path.basename(dir as string)}? This discards everything since that backup.`, false, flags))) { out("Nothing restored."); return; }
	systemctl("stop", `${serviceName()}.service`);
	restore(home, dir as string);
	systemctl("start", `${serviceName()}.service`);
	out("Restored and restarted.");
}

function logsCommand(flags: Flags): void {
	const dirs = layout(lhHome());
	const which = flags._[1] ?? "server";
	const file = which === "service" ? dirs.serviceLog : which === "update" ? dirs.updateLog : dirs.serverLog;
	spawnSync("tail", ["-n", "200", ...(flags.follow === true ? ["-f"] : []), file], { stdio: "inherit" });
}

async function downCommand(): Promise<void> {
	const home = lhHome();
	const config = readConfig(home);
	if (config.tailscale.enabled) serveOff(config.tailscale.port);
	systemctl("disable", "--now", `${serviceName()}.service`);
	out("LearnHarness is stopped and won't start at login. `lh up` turns it back on.");
}

async function uninstallCommand(flags: Flags): Promise<void> {
	const home = lhHome();
	const keepData = flags["keep-data"] === true;
	const what = keepData ? "the LearnHarness service and installed versions (your data stays)" : "LearnHarness completely, including ALL your learning data";
	// --yes confirms an explicit destructive command (unlike the optional restore question in rollback).
	if (flags.yes !== true && !(await ask(`Remove ${what}?`, false, flags))) { out("Nothing removed."); return; }
	await downCommand();
	fs.rmSync(unitPath(), { force: true });
	systemctl("daemon-reload");
	fs.rmSync(shimPath(), { force: true });
	fs.rmSync(layout(home).runtime, { recursive: true, force: true });
	if (!keepData) fs.rmSync(home, { recursive: true, force: true });
	out(keepData ? `Removed. Your data is still in ${layout(home).userdata}.` : "Removed.");
}

// ---------------------------------------------------------------------------
// lh preview <N> (docs/specs/pr-previews.md)

/**
 * Run PR <N>'s preview build in the foreground beside the real server, in a
 * home of its own with fresh, empty data. Ctrl+C stops it and deletes it.
 * Not supervised: no IPC channel, so the in-app updater stays off.
 */
async function previewCommand(flags: Flags): Promise<void> {
	const pr = parsePrNumber(flags._[1]) ?? fail("usage: lh preview <PR number> [--port N]");
	const home = lhHome();
	const real = readConfig(home);
	let port: number | undefined;
	if (typeof flags.port === "string") {
		port = Number(flags.port);
		if (!Number.isInteger(port) || port <= 0 || port >= 65536) fail(`invalid --port ${flags.port}`);
	}
	const config = previewConfig(real, port);
	if (config.port === real.port) fail(`Port ${config.port} is your real server's port. Pick another with --port.`);
	const arch = currentArch() ?? fail("this platform has no self-hosted builds");
	const lockPath = previewLockPath(home, pr);
	const lock = tryAcquireLock(lockPath) ?? fail(`A preview of PR #${pr} is already running.`);
	// A dropped SSH session closes stdout: writes must never stop the cleanup.
	for (const stream of [process.stdout, process.stderr]) stream.on("error", () => { /* terminal gone */ });
	const say = (line = "") => { try { out(line); } catch { /* terminal gone */ } };
	const pHome = previewHome(home, pr);
	const dirs = layout(pHome);
	const serveMarker = previewServeMarker(home, pr);
	let child: ReturnType<typeof spawn> | undefined;
	let stopping = false;
	/** Turn off the Tailscale port the marker names, and delete the preview's folder. */
	const clearPreview = () => {
		try {
			const servedPort = Number(fs.readFileSync(serveMarker, "utf8").trim());
			if (Number.isInteger(servedPort) && servedPort > 0) serveOff(servedPort);
		} catch { /* not served */ }
		fs.rmSync(serveMarker, { force: true });
		fs.rmSync(pHome, { recursive: true, force: true });
	};
	const cleanup = () => {
		clearPreview();
		fs.rmSync(lockPath, { force: true });
		lock.close();
	};
	const logTail = () => {
		try { return fs.readFileSync(dirs.serverLog, "utf8").split("\n").slice(-40).join("\n"); } catch { return ""; }
	};
	const abort = (message: string): never => {
		stopping = true;
		if (child && child.exitCode === null) child.kill("SIGKILL");
		cleanup();
		return fail(message);
	};
	const stop = () => {
		if (stopping) return;
		stopping = true;
		const done = () => {
			cleanup();
			say("\nStopped the preview and deleted its folder.");
			process.exit(0);
		};
		if (!child || child.exitCode !== null) return done();
		child.once("exit", done);
		child.kill("SIGTERM");
		setTimeout(() => child?.kill("SIGKILL"), 15_000).unref();
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
	// Leftovers of a preview that died without cleaning up (the lock proves none runs).
	clearPreview();
	if (!(await portFree(config.port))) abort(`Port ${config.port} is in use. Pick another with --port.`);

	const feedUrl = typeof flags["feed-url"] === "string" ? flags["feed-url"] : previewFeedUrl(pr, real.feedUrl ?? DEFAULT_FEED_URL);
	let feed: Awaited<ReturnType<typeof fetchLatest>>;
	try {
		feed = await fetchLatest(feedUrl);
	} catch (error) {
		return abort(`No preview build for PR #${pr} (${error instanceof Error ? error.message : String(error)}). Your PRs build one on every push; anyone else's when you add the \`preview\` label.`);
	}
	say(`Downloading the PR #${pr} preview ${feed.version} (${feed.sha.slice(0, 12)}).`);
	try {
		await stageVersion(pHome, feed, arch);
	} catch (error) {
		abort(`Could not download the preview: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (stopping) return;
	if (config.tailscale.enabled) {
		// Written first, so a crash between the two still lets the next run turn it off.
		writeFileDurably(serveMarker, `${config.tailscale.port}\n`);
		const ts = tailscaleAvailable() ? serveOn(config.tailscale.port, config.port) : { ok: false, output: "tailscale is not running" };
		if (!ts.ok) {
			fs.rmSync(serveMarker, { force: true });
			say(`Tailscale Serve on port ${config.tailscale.port} failed (${ts.output}); the preview is local only.`);
			config.tailscale = { enabled: false, port: config.tailscale.port };
		}
	}
	writeConfig(pHome, config);

	const p = versionPaths(pHome, feed.version);
	fs.mkdirSync(dirs.logs, { recursive: true });
	const log = fs.openSync(dirs.serverLog, "a");
	child = spawn(p.node, [p.serverEntry], { cwd: p.serverDir, env: buildChildEnv({ home: pHome, config, serviceEnv: {} }), stdio: ["ignore", log, log] });
	fs.closeSync(log);
	child.once("error", (error) => { if (!stopping) abort(`Could not start the preview server: ${error.message}`); });
	child.once("exit", (code, signal) => {
		if (stopping) return;
		try { process.stderr.write(`${logTail()}\n`); } catch { /* terminal gone */ }
		abort(`The preview server exited (${signal ?? `code ${code}`}).`);
	});

	const deadline = Date.now() + 120_000;
	while (!stopping && !(await fetchHealth(config.port, 3_000).catch(() => undefined))?.ok) {
		if (Date.now() > deadline) {
			try { process.stderr.write(`${logTail()}\n`); } catch { /* terminal gone */ }
			abort("The preview never became healthy within 120s.");
		}
		await sleep(500);
	}
	if (stopping) return;
	say("");
	say(`PR #${pr} preview ${feed.version} (${feed.sha.slice(0, 12)}) is running, with fresh, empty data:`);
	for (const url of urls(config)) say(`  ${url}`);
	say("");
	try { printPairingLink(pHome, config, `PR #${pr} preview`); } catch { /* terminal gone */ }
	say(`Server log: ${dirs.serverLog}`);
	say("Your real server, its data and its updates are untouched. Ctrl+C stops the preview and deletes it.");
	setInterval(() => { /* stay up until Ctrl+C */ }, 1 << 30);
}

const HELP = `lh: run LearnHarness as a self-hosted server

  lh up [--port N] [--tailscale|--no-tailscale] [--tailscale-port N] [--chrome-path P] [--no-linger] [--no-open] [--yes]
  lh pair [--label NAME]         a one-time pairing link and QR code for a new device
  lh status                      versions, service, health, URLs
  lh update [--now]              check now; --now installs right away
  lh rollback                    switch back to the previous version
  lh use <version>               switch to an installed version
  lh restart                     restart the service (never required)
  lh restore [<backup>]          list backups, or restore one
  lh versions                    installed versions
  lh logs [server|service|update] [-f]
  lh preview <PR> [--port N]     run a PR's preview build beside your server (fresh data; Ctrl+C deletes it)
  lh down                        stop and disable the service
  lh uninstall [--keep-data]`;

async function main(): Promise<void> {
	const flags = parseArgs(process.argv.slice(2));
	const command = flags._[0] ?? "help";
	switch (command) {
		case "__service": return runService();
		case "__selftest-launcher": return selftestLauncherCommand();
		case "__selftest": return selftestArchive(flags);
		case "__install": return installCommand(flags);
		case "up": return upCommand(flags);
		case "pair": return pairCommand(flags);
		case "status": return statusCommand();
		case "update": return updateCommand(flags);
		case "rollback": {
			const state = requireState(lhHome());
			if (!state.previousVersion) fail("There's no previous version to roll back to.");
			return switchCommand(state.previousVersion as string, flags, "lh rollback");
		}
		case "use": return switchCommand(flags._[1] ?? fail("usage: lh use <version>"), flags, "lh use");
		case "restart": {
			const r = systemctl("restart", `${serviceName()}.service`);
			if (!r.ok) fail(r.stderr.trim());
			out("Restarted.");
			return;
		}
		case "restore": return restoreCommand(flags._[1], flags);
		case "versions": {
			const state = readState(lhHome());
			for (const v of installedVersions(lhHome())) out(`${v}${v === state?.activeVersion ? "  (active)" : v === state?.previousVersion ? "  (previous)" : ""}`);
			return;
		}
		case "logs": return logsCommand(flags);
		case "preview": return previewCommand(flags);
		case "down": return downCommand();
		case "uninstall": return uninstallCommand(flags);
		case "help":
		case "--help":
		case "-h": out(HELP); return;
		default: fail(`unknown command ${command}. Run \`lh help\`.`);
	}
}

void main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
