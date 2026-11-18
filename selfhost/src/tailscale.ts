/**
 * Tailscale Serve: HTTPS on your tailnet in front of 127.0.0.1:<port>.
 * Never Funnel: Funnel makes the server public; pairing is all that keeps a
 * reachable server private.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

/** The Mac app's own CLI, for when `tailscale` isn't on PATH (the App Store and standalone apps). */
export const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

let resolved: string | undefined;

/** `tailscale` on PATH, else the Mac app's CLI when it exists. */
export function tailscaleBin(platform: string = process.platform, onPath: () => boolean = () => spawnSync("tailscale", ["version"], { encoding: "utf8" }).error === undefined, exists: (file: string) => boolean = fs.existsSync): string {
	if (platform === "darwin" && !onPath() && exists(MAC_APP_CLI)) return MAC_APP_CLI;
	return "tailscale";
}

const tailscale = (args: string[]) => spawnSync((resolved ??= tailscaleBin()), args, { encoding: "utf8" });

export interface TailscaleSelf {
	/** MagicDNS name without the trailing dot, e.g. box.tailnet.ts.net */
	dnsName: string;
}

export function tailscaleAvailable(): boolean {
	return tailscale(["version"]).status === 0;
}

export function tailscaleSelf(): TailscaleSelf | undefined {
	const result = tailscale(["status", "--json"]);
	if (result.status !== 0) return undefined;
	try {
		const status = JSON.parse(result.stdout) as { Self?: { DNSName?: string } };
		const name = status.Self?.DNSName?.replace(/\.$/, "");
		return name ? { dnsName: name } : undefined;
	} catch {
		return undefined;
	}
}

export function serveOn(httpsPort: number, localPort: number): { ok: boolean; output: string } {
	const result = tailscale(["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`]);
	return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export function serveOff(httpsPort: number): { ok: boolean; output: string } {
	const result = tailscale(["serve", `--https=${httpsPort}`, "off"]);
	return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}
