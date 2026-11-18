/**
 * PR previews (docs/specs/pr-previews.md): `lh preview <N>` runs a PR's
 * preview build beside the real server, in a home of its own under
 * ~/.learnharness/previews/pr-<N>/ with fresh, empty data. These are its
 * helpers; lh.ts runs it.
 *
 * Node built-ins only, erasable TypeScript only (see protocol.ts).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LhConfig } from "./config.ts";
import { DEFAULT_FEED_URL } from "./release.ts";

/** A PR number as typed: digits only, no leading zero, `#` allowed. */
export function parsePrNumber(value: string | undefined): number | undefined {
	const match = /^#?([1-9]\d{0,8})$/.exec(value ?? "");
	return match ? Number(match[1]) : undefined;
}

/** The preview release's latest.json: the nightly feed URL with the `nightly` tag swapped for `preview-pr-<N>`. */
export function previewFeedUrl(pr: number, nightlyFeedUrl: string = DEFAULT_FEED_URL): string {
	const match = /^(.*\/)nightly\/latest\.json$/.exec(nightlyFeedUrl);
	if (!match) throw new Error(`Can't find previews next to the feed ${nightlyFeedUrl}; pass --feed-url.`);
	return `${match[1]}preview-pr-${pr}/latest.json`;
}

/** A preview's own LH_HOME (build, data, logs). Deleted when the preview stops. */
export function previewHome(home: string, pr: number): string {
	return path.join(home, "previews", `pr-${pr}`);
}

/** Held while a preview runs; outside its home so the home can be deleted under it. */
export function previewLockPath(home: string, pr: number): string {
	return path.join(home, "previews", `pr-${pr}.lock`);
}

/**
 * The running preview server's pid (and, off Linux, its start time on the
 * next line), so the next run can stop a server whose launcher died.
 */
export function previewPidPath(home: string, pr: number): string {
	return path.join(home, "previews", `pr-${pr}.pid`);
}

/**
 * When a process started, to the second, as `ps -o lstart=` prints it, or
 * undefined if there is no such process. A process that reuses a pid starts
 * later, so the pid and its start time name one process.
 */
export function processStartTime(pid: number): string | undefined {
	const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
	return (ps.status === 0 && ps.stdout.trim()) || undefined;
}

/**
 * Whether the pid file's process is still this preview's server. On Linux
 * its environment names the preview's home (Next renames the process, so not
 * its command line). macOS has no /proc, so there the pid file also holds the
 * server's start time, and the process must have started then.
 */
export function isPreviewServer(
	pid: number,
	pHome: string,
	started: string | undefined,
	{ platform = process.platform, startTime = processStartTime }: { platform?: string; startTime?: (pid: number) => string | undefined } = {},
): boolean {
	if (platform === "linux") {
		try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`LH_HOME=${pHome}`); } catch { return false; }
	}
	return started !== undefined && startTime(pid) === started;
}

/** The Tailscale Serve port a preview turned on, so a preview that died can have it turned off by the next run. */
export function previewServeMarker(home: string, pr: number): string {
	return path.join(home, "previews", `pr-${pr}.serve`);
}

/**
 * The preview's config.json: the real port + 1 (or --port) and, when
 * Tailscale is on, the real Tailscale port shifted by the same amount, on
 * the same machine name, so two previews on two ports never share one. The
 * preview server reads it for the Tailscale address in pairing links.
 */
export function previewConfig(real: LhConfig, port?: number): LhConfig {
	const local = port ?? real.port + 1;
	const tsPort = real.tailscale.port + (local - real.port);
	const tailscale = real.tailscale.enabled && real.tailscale.hostname && tsPort > 0 && tsPort < 65536 && tsPort !== real.tailscale.port
		? { enabled: true, port: tsPort, hostname: real.tailscale.hostname }
		: { enabled: false, port: tsPort };
	return {
		port: local,
		tailscale,
		...(real.chromePath ? { chromePath: real.chromePath } : {}),
	};
}

/** Wait for the launcher to persist our PID before the server can start. */
export const PREVIEW_START = `data:text/javascript,${encodeURIComponent(
	'import { readFileSync } from "node:fs"; if (readFileSync(0, "utf8") !== "start") process.exit(1);',
)}`;
