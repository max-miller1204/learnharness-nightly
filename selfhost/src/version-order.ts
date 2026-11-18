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
