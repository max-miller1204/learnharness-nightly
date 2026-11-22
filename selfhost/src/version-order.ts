/**
 * Version order, shared by the launcher, the server (through release.ts)
 * and the web app (the sidebar update control). No imports: client-safe.
 */
// Versions: <x.y.z>-nightly.<YYYYMMDD>.<run> (T3's scheme), plus plain x.y.z.

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d{8})\.(\d+))?$/;

export function isExactVersion(version: string): boolean {
	return VERSION_RE.test(version);
}

/** Negative, zero or positive like a sort comparator. Unknown shapes compare as equal-to-nothing (throw). */
export function compareVersions(a: string, b: string): number {
	const pa = VERSION_RE.exec(a);
	const pb = VERSION_RE.exec(b);
	if (!pa || !pb) throw new Error(`Not an exact version: ${!pa ? a : b}`);
	for (const i of [1, 2, 3]) {
		const d = Number(pa[i]) - Number(pb[i]);
		if (d !== 0) return d;
	}
	// A plain release sorts after its own prereleases (semver).
	if (!pa[4] && pb[4]) return 1;
	if (pa[4] && !pb[4]) return -1;
	if (!pa[4] || !pb[4]) return 0;
	const date = Number(pa[5]) - Number(pb[5]);
	if (date !== 0) return date;
	return Number(pa[6]) - Number(pb[6]);
}

/** True when both are exact versions and `a` is newer. Never throws. */
export function isNewerVersion(a: string | null | undefined, b: string | null | undefined): boolean {
	return !!a && !!b && isExactVersion(a) && isExactVersion(b) && compareVersions(a, b) > 0;
}

/** The release track of an exact version: its prerelease label ("nightly", "preview"), or "" for a
 *  plain release. Null for anything that isn't an exact version. */
export function releaseTrack(version: string | null | undefined): string | null {
	const match = version ? VERSION_RE.exec(version) : null;
	return match ? (match[4] ?? "") : null;
}

/** True when both are exact versions on the same release track: both nightlies, both previews
 *  (`lh preview`), or both plain releases. T3 never compares across channels
 *  (`resolveVersionMismatch` compares full nightly versions only when both are nightlies,
 *  `apps/web/src/versionSkew.ts:62-70`, and `collectServerUpdateTargets` skips a server on another
 *  channel, `updateEverything.logic.ts:121-130`, at df09ced7). A plain "0.7.0" sorts after every
 *  "0.7.0-nightly.*", and a preview sorts against a nightly by its date: neither is an update for
 *  the other. */
export function sameReleaseTrack(a: string | null | undefined, b: string | null | undefined): boolean {
	const track = releaseTrack(a);
	return track !== null && track === releaseTrack(b);
}
