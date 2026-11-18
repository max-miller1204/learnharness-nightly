/**
 * The background service and the ~/.local/bin/lh shim (modeled on T3 Code's
 * ~/.config/systemd/user/t3code.service, its launchd agent and ~/.local/bin/t3).
 *
 * Linux: a systemd user unit whose ExecStart names one version's launcher.
 * It's repointed only after a commit (T3's repointServiceUnit), so the
 * running launcher is never replaced mid-update.
 *
 * macOS: a launchd agent (docs/specs/macos-selfhost.md) whose
 * ProgramArguments name the shim instead. launchd keeps the plist it loaded
 * and restarts that command until the next bootstrap, so a version path
 * would bring back the old launcher; the shim is repointed at the same
 * moments the systemd unit is.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { layout, serviceName, versionPaths } from "./paths.ts";
import { writeFileDurably } from "./release.ts";

export function unitDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	return path.join(xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config"), "systemd", "user");
}

export function unitPath(name: string = serviceName()): string {
	return path.join(unitDir(), `${name}.service`);
}

/** ~/.local/bin/lh; LH_BIN_DIR moves it (tests and the end-to-end check use a scratch folder). */
export function shimPath(): string {
	const dir = process.env.LH_BIN_DIR;
	return path.join(dir && dir.length > 0 ? dir : path.join(os.homedir(), ".local", "bin"), "lh");
}

export function renderUnit(home: string, version: string, name: string = serviceName()): string {
	const dirs = layout(home);
	return [
		"[Unit]",
		"Description=LearnHarness server",
		"StartLimitIntervalSec=300",
		"StartLimitBurst=5",
		"",
		"[Service]",
		"Type=simple",
		"WorkingDirectory=%h",
		`Environment=LH_HOME=${home}`,
		`Environment=LH_SERVICE_NAME=${name}`,
		...(process.env.LH_BIN_DIR ? [`Environment=LH_BIN_DIR=${process.env.LH_BIN_DIR}`] : []),
		`ExecStart=${versionPaths(home, version).lh} __service`,
		"KillMode=mixed",
		"TimeoutStopSec=30",
		"Restart=always",
		"RestartSec=5",
		"OOMPolicy=continue",
		`StandardOutput=append:${dirs.serviceLog}`,
		`StandardError=append:${dirs.serviceLog}`,
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

const EXEC_START = /^(ExecStart=.*?[\\/]runtime[\\/]versions[\\/])([^\\/\s]+)([\\/]lh\b)/m;

/** Point an existing unit's ExecStart at `version`; returns the new text (unchanged if no match). */
export function repointUnitText(contents: string, version: string): string {
	return contents.replace(EXEC_START, (_m, prefix: string, _old: string, suffix: string) => `${prefix}${version}${suffix}`);
}

export function unitVersion(contents: string): string | undefined {
	return EXEC_START.exec(contents)?.[2];
}

export function writeShim(home: string, version: string): void {
	const target = versionPaths(home, version).lh;
	const shim = shimPath();
	fs.mkdirSync(path.dirname(shim), { recursive: true });
	writeFileDurably(shim, `#!/bin/sh\nexec '${target.replaceAll("'", "'\\''")}' "$@"\n`);
	fs.chmodSync(shim, 0o755);
}

/** systemctl --user, the Linux backend. */
export function systemctl(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error?.message ?? "") };
}

export function hasSystemd(): boolean {
	return systemctl("--version").ok;
}

export function writeUnit(home: string, version: string, name: string = serviceName()): void {
	const dirs = layout(home);
	fs.mkdirSync(dirs.logs, { recursive: true });
	writeFileDurably(unitPath(name), renderUnit(home, version, name));
}

/** Best-effort repoint + daemon-reload (T3 treats this as reconciliation, not a gate). */
export function repointService(home: string, version: string, name: string = serviceName(), platform: string = process.platform): string | undefined {
	try {
		if (platform === "darwin") {
			writeShim(home, version);
			return undefined;
		}
		const file = unitPath(name);
		const contents = fs.readFileSync(file, "utf8");
		const next = repointUnitText(contents, version);
		if (next !== contents) writeFileDurably(file, next);
		writeShim(home, version);
		const reload = systemctl("daemon-reload");
		return reload.ok ? undefined : `systemctl daemon-reload failed: ${reload.stderr.trim()}`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function lingerEnabled(): boolean {
	const user = os.userInfo().username;
	const result = spawnSync("loginctl", ["show-user", user, "--property=Linger"], { encoding: "utf8" });
	return /Linger=yes/.test(result.stdout ?? "");
}

export function enableLinger(): boolean {
	return spawnSync("loginctl", ["enable-linger", os.userInfo().username], { stdio: "inherit" }).status === 0;
}

// ---------------------------------------------------------------------------
// One interface over systemd and launchd

export interface ServiceResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export interface ServiceManager {
	readonly kind: "systemd" | "launchd";
	/** The unit file or plist. */
	readonly file: string;
	/** What `lh status` names, e.g. learnharness.service or com.learnharness.server. */
	readonly displayName: string;
	available(): boolean;
	/** Write the unit or plist and the shim for `version`, and reload the manager. */
	write(home: string, version: string): void;
	isRunning(): boolean;
	/** systemd's is-active word, or launchd's job state. */
	state(): string;
	/** Start now and at every login. */
	enable(): ServiceResult;
	start(): ServiceResult;
	stop(): ServiceResult;
	restart(): ServiceResult;
	/** Stop now and don't start at login. */
	disable(): ServiceResult;
	/** Delete the unit file or plist (after disable). */
	remove(): void;
}

function systemdManager(name: string): ServiceManager {
	const unit = `${name}.service`;
	return {
		kind: "systemd",
		file: unitPath(name),
		displayName: unit,
		available: hasSystemd,
		write(home, version) {
			writeUnit(home, version, name);
			writeShim(home, version);
			systemctl("daemon-reload");
		},
		isRunning: () => systemctl("is-active", unit).stdout.trim() === "active",
		state: () => systemctl("is-active", unit).stdout.trim() || "unknown",
		enable: () => systemctl("enable", "--now", unit),
		start: () => systemctl("start", unit),
		stop: () => systemctl("stop", unit),
		restart: () => systemctl("restart", unit),
		disable: () => systemctl("disable", "--now", unit),
		remove() {
			fs.rmSync(unitPath(name), { force: true });
			systemctl("daemon-reload");
		},
	};
}

/** com.learnharness.server; a test service name gets its own label. */
export function launchdLabel(name: string = serviceName()): string {
	return name === "learnharness" ? "com.learnharness.server" : `com.learnharness.${name}`;
}

export function plistPath(name: string = serviceName()): string {
	return path.join(os.homedir(), "Library", "LaunchAgents", `${launchdLabel(name)}.plist`);
}

/**
 * The service's PATH (T3's environmentPath): launch agents don't get your
 * shell's PATH, so take the one `lh up` runs with, minus version folders
 * (they change at every update), then Homebrew and the system folders.
 */
export function launchdPath(home: string, inherited: string = process.env.PATH ?? ""): string {
	const versions = layout(home).versions + path.sep;
	const printable = (dir: string) => Array.from(dir).every((c) => c.charCodeAt(0) >= 0x20);
	const fromShell = inherited.split(":").filter((dir) => dir.length > 0 && printable(dir) && !`${dir}${path.sep}`.startsWith(versions));
	return Array.from(new Set([...fromShell, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])).join(":");
}

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** T3's plist keys; ExitTimeOut matches the systemd unit's TimeoutStopSec. */
export function renderPlist(home: string, name: string = serviceName(), environmentPath: string = launchdPath(home)): string {
	const dirs = layout(home);
	const env: Array<[string, string]> = [
		["PATH", environmentPath],
		["LH_HOME", home],
		["LH_SERVICE_NAME", name],
		...(process.env.LH_BIN_DIR ? [["LH_BIN_DIR", process.env.LH_BIN_DIR] as [string, string]] : []),
	];
	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
		`<plist version="1.0">`,
		`<dict>`,
		`  <key>Label</key>`,
		`  <string>${xml(launchdLabel(name))}</string>`,
		`  <key>ProgramArguments</key>`,
		`  <array>`,
		`    <string>${xml(shimPath())}</string>`,
		`    <string>__service</string>`,
		`  </array>`,
		`  <key>EnvironmentVariables</key>`,
		`  <dict>`,
		...env.flatMap(([key, value]) => [`    <key>${key}</key>`, `    <string>${xml(value)}</string>`]),
		`  </dict>`,
		`  <key>WorkingDirectory</key>`,
		`  <string>${xml(os.homedir())}</string>`,
		`  <key>RunAtLoad</key>`,
		`  <true/>`,
		`  <key>KeepAlive</key>`,
		`  <true/>`,
		`  <key>ThrottleInterval</key>`,
		`  <integer>5</integer>`,
		`  <key>ExitTimeOut</key>`,
		`  <integer>30</integer>`,
		`  <key>ProcessType</key>`,
		`  <string>Interactive</string>`,
		`  <key>StandardOutPath</key>`,
		`  <string>${xml(dirs.serviceLog)}</string>`,
		`  <key>StandardErrorPath</key>`,
		`  <string>${xml(dirs.serviceLog)}</string>`,
		`</dict>`,
		`</plist>`,
		``,
	].join("\n");
}

/** The job state from `launchctl print` ("running", "not running", ...), or undefined. */
export function parseLaunchdState(printed: string): string | undefined {
	return /^\s*state = (.+?)\s*$/m.exec(printed)?.[1];
}

export function launchctl(...args: string[]): ServiceResult {
	const result = spawnSync("launchctl", args, { encoding: "utf8", timeout: 60_000 });
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error?.message ?? "") };
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function launchdManager(name: string): ServiceManager {
	const label = launchdLabel(name);
	const domain = `gui/${process.getuid?.() ?? 0}`;
	const target = `${domain}/${label}`;
	const file = plistPath(name);
	const loaded = () => launchctl("print", target).ok;
	// Unloaded jobs reject bootout; bootout --wait (T3) waits through ExitTimeOut.
	const stop = (): ServiceResult => (loaded() ? launchctl("bootout", "--wait", target) : { ok: true, stdout: "", stderr: "" });
	/**
	 * Every start is a fresh bootstrap, so a rewritten plist always takes
	 * effect: a loaded job (running, crash-looping or throttled) is booted out
	 * first. A persisted `launchctl disable` (from `lh down`) refuses
	 * bootstrap, so it is cleared first, as T3 does; like `systemctl start`,
	 * starting by hand turns the service back on.
	 */
	const start = (): ServiceResult => {
		const stopped = stop();
		if (!stopped.ok) return stopped;
		launchctl("enable", target);
		// A bootstrap right after a bootout can fail with EIO while launchd tears the old job down.
		let result = launchctl("bootstrap", domain, file);
		for (let attempt = 0; !result.ok && attempt < 5 && !loaded(); attempt++) {
			pause(1000);
			result = launchctl("bootstrap", domain, file);
		}
		return result.ok || !loaded() ? result : { ok: true, stdout: "", stderr: "" };
	};
	return {
		kind: "launchd",
		file,
		displayName: label,
		available: () => spawnSync("launchctl", ["help"], { encoding: "utf8" }).error === undefined,
		write(home, version) {
			fs.mkdirSync(layout(home).logs, { recursive: true });
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeFileDurably(file, renderPlist(home, name));
			writeShim(home, version);
		},
		isRunning: () => parseLaunchdState(launchctl("print", target).stdout) === "running",
		state() {
			const printed = launchctl("print", target);
			return printed.ok ? (parseLaunchdState(printed.stdout) ?? "loaded") : "not loaded";
		},
		enable: start,
		start,
		stop,
		restart: start,
		disable() {
			const stopped = stop();
			const disabled = launchctl("disable", target);
			return stopped.ok ? disabled : stopped;
		},
		remove() {
			fs.rmSync(file, { force: true });
		},
	};
}

/** The backend for this machine: launchd on macOS, systemd elsewhere. */
export function serviceManager(platform: string = process.platform, name: string = serviceName()): ServiceManager {
	return platform === "darwin" ? launchdManager(name) : systemdManager(name);
}
