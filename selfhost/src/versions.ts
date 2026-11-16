/** Installed-version housekeeping: keep the newest few, never the ones in use. */
import * as fs from "node:fs";
import * as path from "node:path";
import { layout, versionDir } from "./paths.ts";
import { compareVersions, installedVersions, isExactVersion } from "./release.ts";

export const KEEP_VERSIONS = 3;

/** Remove installed versions beyond the newest `keep`, never touching `protect`. Also clears stale .tmp folders. */
export function pruneVersions(home: string, protect: readonly (string | undefined)[], keep: number = KEEP_VERSIONS): string[] {
	const keepSet = new Set(protect.filter((v): v is string => typeof v === "string"));
	const installed = installedVersions(home).sort(compareVersions);
	const removable = installed.filter((v) => !keepSet.has(v));
	const budget = Math.max(0, keep - keepSet.size);
	const doomed = removable.slice(0, Math.max(0, removable.length - budget));
	for (const version of doomed) fs.rmSync(versionDir(home, version), { recursive: true, force: true });
	// Leftovers from an interrupted extraction.
	try {
		for (const name of fs.readdirSync(layout(home).versions)) {
			if (name.endsWith(".tmp") && isExactVersion(name.slice(0, -4))) {
				fs.rmSync(path.join(layout(home).versions, name), { recursive: true, force: true });
			}
		}
	} catch { /* no versions dir yet */ }
	return doomed;
}
