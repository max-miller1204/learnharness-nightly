/** Real server children, health checks and per-version metadata for the supervisor. */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildHandle, ChildRole } from "./supervisor.ts";
import type { ParentMessage } from "./protocol.ts";
import { layout, versionPaths } from "./paths.ts";

export const STOP_GRACE_MS = 15_000;

export function spawnServerChild(home: string, version: string, role: ChildRole, env: NodeJS.ProcessEnv): ChildHandle {
	const p = versionPaths(home, version);
	const dirs = layout(home);
	fs.mkdirSync(dirs.logs, { recursive: true });
	const out = fs.openSync(dirs.serverLog, "a");
	const child = spawn(p.node, [p.serverEntry], { cwd: p.serverDir, env, stdio: ["ignore", out, out, "ipc"] });
	fs.closeSync(out);
	let exited = false;
	const exitWaiters: Array<() => void> = [];
	child.once("exit", () => {
		exited = true;
		for (const waiter of exitWaiters.splice(0)) waiter();
	});
	child.on("error", () => { /* surfaced through exit */ });
	const handle: ChildHandle = {
		version,
		role,
		send(message: ParentMessage) {
			if (child.connected) child.send(message);
		},
		onMessage(cb) { child.on("message", cb); },
		onExit(cb) { child.once("exit", (code, signal) => cb(code, signal)); },
		stop() {
			if (exited) return Promise.resolve();
			return new Promise<void>((resolve) => {
				exitWaiters.push(resolve);
				child.kill("SIGTERM");
				const kill = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, STOP_GRACE_MS);
				kill.unref();
			});
		},
	};
	return handle;
}

export async function fetchHealth(port: number, timeoutMs = 5_000, authorization?: string): Promise<{ ok: boolean; idle?: boolean; version?: string; update?: unknown; selfhost?: boolean }> {
	// With a session (`lh status`) the answer includes update error text.
	const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs), ...(authorization ? { headers: { Authorization: authorization } } : {}) });
	if (!response.ok) return { ok: false };
	const body = (await response.json()) as { ok?: unknown; idle?: unknown; version?: unknown; update?: unknown; selfhost?: unknown };
	return {
		ok: body.ok === true,
		...(typeof body.idle === "boolean" ? { idle: body.idle } : {}),
		...(typeof body.version === "string" ? { version: body.version } : {}),
		...(typeof body.selfhost === "boolean" ? { selfhost: body.selfhost } : {}),
		update: body.update,
	};
}

/** PROTOCOL.json, written into every archive at package time. */
export function readVersionProtocol(home: string, version: string): { launcherProtocol: number; minLauncherProtocol: number } {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(versionPaths(home, version).dir, "PROTOCOL.json"), "utf8")) as Record<string, unknown>;
		const launcherProtocol = Number.isInteger(raw.launcherProtocol) ? (raw.launcherProtocol as number) : 1;
		const minLauncherProtocol = Number.isInteger(raw.minLauncherProtocol) ? (raw.minLauncherProtocol as number) : 1;
		return { launcherProtocol, minLauncherProtocol };
	} catch {
		return { launcherProtocol: 1, minLauncherProtocol: 1 };
	}
}

/** Run a version's own launcher in self-test mode (loads its code, reads state and locks, exits 0). */
export function selftestLauncher(home: string, version: string): boolean {
	const result = spawnSync(versionPaths(home, version).lh, ["__selftest-launcher"], {
		env: { ...process.env, LH_HOME: home },
		encoding: "utf8",
		timeout: 60_000,
	});
	return result.status === 0;
}
