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

/**
 * The preview's config.json: the real port + 1 and, when Tailscale is on,
 * the real Tailscale port + 1 on the same machine name. The preview server
 * reads it for the Tailscale address in pairing links.
 */
export function previewConfig(real: LhConfig, port?: number): LhConfig {
	const tailscale = real.tailscale.enabled && real.tailscale.hostname
		? { enabled: true, port: real.tailscale.port + 1, hostname: real.tailscale.hostname }
		: { enabled: false, port: real.tailscale.port + 1 };
	return {
		port: port ?? real.port + 1,
		tailscale,
		...(real.chromePath ? { chromePath: real.chromePath } : {}),
	};
}
