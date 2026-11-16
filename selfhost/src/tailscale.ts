/**
 * Tailscale Serve: HTTPS on your tailnet in front of 127.0.0.1:<port>.
 * Never Funnel: Funnel makes the server public, and LearnHarness has no login.
 */
import { spawnSync } from "node:child_process";

export interface TailscaleSelf {
	/** MagicDNS name without the trailing dot, e.g. box.tailnet.ts.net */
	dnsName: string;
}

export function tailscaleAvailable(): boolean {
	return spawnSync("tailscale", ["version"], { encoding: "utf8" }).status === 0;
}

export function tailscaleSelf(): TailscaleSelf | undefined {
	const result = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8" });
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
	const result = spawnSync("tailscale", ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`], { encoding: "utf8" });
	return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export function serveOff(httpsPort: number): { ok: boolean; output: string } {
	const result = spawnSync("tailscale", ["serve", `--https=${httpsPort}`, "off"], { encoding: "utf8" });
	return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}
