/**
 * Write latest.json for the fixed `nightly` release (CI, nightly.yml and
 * feed-check.yml):
 *
 *   node selfhost/scripts/make-feed.ts --version V --tag vV --sha <commit> \
 *     --repo owner/name --dir <folder with the .tar.gz.sha256 files> [--published-at ISO] \
 *     [--notes notes.json] [--previous previous-latest.json] > latest.json
 *
 * Asset URLs point at the per-version prerelease, so every install verifies
 * against the exact files of that release.
 *
 * Notes: --notes is this release's entry ({ version, publishedAt, items },
 * from scripts/generate-release-notes.ts or the commit-list fallback);
 * --previous is the `nightly` release's latest.json before this publish.
 * The feed's `notes` is this entry, then the previous feed's entries, newest
 * FEED_NOTES_KEEP kept (docs/specs/t3-style-updates.md).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { LAUNCHER_PROTOCOL, MIN_LAUNCHER_PROTOCOL } from "../src/protocol.ts";
import { mergeFeedNotes, parseFeed, parseFeedNotes, type LatestFeed } from "../src/release.ts";

const { values } = parseArgs({
	options: {
		version: { type: "string" },
		tag: { type: "string" },
		sha: { type: "string" },
		repo: { type: "string" },
		dir: { type: "string" },
		"published-at": { type: "string" },
		"launcher-protocol": { type: "string" },
		"min-launcher-protocol": { type: "string" },
		notes: { type: "string" },
		previous: { type: "string" },
	},
});
const dir = path.resolve(values.dir ?? ".");
const assets: LatestFeed["assets"] = {};
for (const arch of ["linux-x64", "linux-arm64"] as const) {
	const name = `learnharness-${values.version}-${arch}.tar.gz`;
	const shaFile = path.join(dir, `${name}.sha256`);
	if (!fs.existsSync(shaFile)) continue;
	const sha256 = fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0] ?? "";
	assets[arch] = { url: `https://github.com/${values.repo}/releases/download/${values.tag}/${name}`, sha256 };
}
const readJson = (file: string | undefined): unknown => {
	if (!file || !fs.existsSync(file)) return undefined;
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
};
const previousFeed = readJson(values.previous);
const previousNotes = parseFeedNotes(typeof previousFeed === "object" && previousFeed !== null ? (previousFeed as { notes?: unknown }).notes : undefined);
const [entry] = parseFeedNotes([readJson(values.notes)]);
const notes = entry ? mergeFeedNotes(entry, previousNotes) : previousNotes;
const feed = parseFeed({
	version: values.version,
	tag: values.tag,
	sha: values.sha,
	publishedAt: values["published-at"] ?? new Date().toISOString(),
	launcherProtocol: values["launcher-protocol"] ? Number(values["launcher-protocol"]) : LAUNCHER_PROTOCOL,
	minLauncherProtocol: values["min-launcher-protocol"] ? Number(values["min-launcher-protocol"]) : MIN_LAUNCHER_PROTOCOL,
	assets,
	notes,
});
if (Object.keys(feed.assets).length === 0) throw new Error(`no archives for ${values.version} in ${dir}`);
process.stdout.write(`${JSON.stringify(feed, null, 2)}\n`);
