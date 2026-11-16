/**
 * The systemd user unit and the ~/.local/bin/lh shim (modeled on T3 Code's
 * ~/.config/systemd/user/t3code.service and ~/.local/bin/t3).
 *
 * The unit's ExecStart names one version's launcher. It's repointed only
 * after a commit (T3's repointServiceUnit), so the running launcher is never
 * replaced mid-update.
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
export function repointService(home: string, version: string, name: string = serviceName()): string | undefined {
	try {
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
