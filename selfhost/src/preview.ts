/**
 * PR previews (docs/specs/pr-previews.md): `lh preview <N>` runs a PR's
 * preview build beside the real server, in a home of its own under
 * ~/.learnharness/previews/pr-<N>/ with fresh, empty data. These are the
 * pure parts; lh.ts runs it.
 *
 * Node built-ins only, erasable TypeScript only (see protocol.ts).
 */
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
