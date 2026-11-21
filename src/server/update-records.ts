/**
 * The per-server update records in the data folder
 * (docs/specs/t3-style-updates.md, section 6). "Per server": every browser
 * on this server reads the same files, so seeing What's new (or dismissing a
 * rollback notice) on one device clears it on all of them.
 *
 *   release-notes.json  { groups: ReleaseNoteGroup[] }, newest 30 versions.
 *                       Written by the self-hosted updater on each check and
 *                       by the desktop shell (electron/main.cjs) before it
 *                       installs; the Electron copy of this format lives in
 *                       electron/release-notes.cjs.
 *   updates.json        { lastSeenVersion?, dismissedNotice? }
 */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { capReleaseNoteGroups, MAX_RELEASE_NOTE_ITEMS, noteReleasedAt, totalReleaseItems, truncateReleaseNoteItem, type ReleaseNoteGroup } from "../core/release-notes.ts";
import { compareVersions, FEED_NOTE_LIMITS, FEED_NOTES_KEEP, isExactVersion, type FeedNote } from "../../selfhost/src/release.ts";

export interface UpdateRecord {
	lastSeenVersion?: string;
	dismissedNotice?: string;
}

/** GET /api/whats-new. */
export interface WhatsNew {
	version: string;
	releaseNotes: ReleaseNoteGroup[];
	omittedReleaseCount: number;
}

const notesFile = (dir: string) => path.join(dir, "release-notes.json");
const recordFile = (dir: string) => path.join(dir, "updates.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(file: string): unknown {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}

/** A summary field trimmed, its whitespace collapsed, then held to the feed's bound (dropped past it). */
function summaryText(key: keyof typeof FEED_NOTE_LIMITS, value: unknown): Partial<Record<keyof typeof FEED_NOTE_LIMITS, string>> {
	if (typeof value !== "string") return {};
	const text = value.trim().replace(/\s+/g, " ");
	return text && text.length <= FEED_NOTE_LIMITS[key] ? { [key]: text } : {};
}

function parseGroups(value: unknown): ReleaseNoteGroup[] {
	if (!Array.isArray(value)) return [];
	const groups: ReleaseNoteGroup[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.version !== "string" || !isExactVersion(entry.version) || seen.has(entry.version) || !Array.isArray(entry.items)) continue;
		seen.add(entry.version);
		// T3's summary extras, when the feed (or an older cache) has them.
		const summary = { ...summaryText("intro", entry.intro), ...summaryText("stats", entry.stats), ...summaryText("footer", entry.footer) };
		// The old-client copy of the intro or footer stays (pages from before the fields show it);
		// the renderer drops it (src/core/release-notes.ts withoutSummaryEcho). The same limits as the
		// desktop's (electron/release-notes.cjs boundedGroup): 8 items of 220 characters, counted whole first.
		const all = entry.items.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim().replace(/\s+/g, " "));
		const counted = totalReleaseItems({ version: entry.version, items: all, ...summary });
		const items = all.slice(0, MAX_RELEASE_NOTE_ITEMS).map(truncateReleaseNoteItem);
		const releasedAt = noteReleasedAt(entry.releasedAt, entry.version);
		groups.push({
			version: entry.version,
			...(releasedAt ? { releasedAt } : {}),
			items,
			totalItems: Number.isInteger(entry.totalItems) && (entry.totalItems as number) >= items.length ? Math.min(entry.totalItems as number, 10000) : counted,
			...summary,
		});
	}
	return groups.sort((a, b) => compareVersions(b.version, a.version));
}

export function feedNotesToGroups(notes: readonly FeedNote[]): ReleaseNoteGroup[] {
	return parseGroups(notes.map((note) => ({ version: note.version, releasedAt: note.publishedAt, items: note.items, intro: note.intro, stats: note.stats, footer: note.footer })));
}

/** Newest first, versions after `after` (exclusive, when given) up to `upTo` (inclusive), capped for the UI. */
export function groupsBetween(groups: readonly ReleaseNoteGroup[], after: string | undefined, upTo: string): { releaseNotes: ReleaseNoteGroup[]; omittedReleaseCount: number } {
	const inRange = groups.filter((group) =>
		compareVersions(group.version, upTo) <= 0 && (after === undefined || !isExactVersion(after) || compareVersions(group.version, after) > 0));
	return capReleaseNoteGroups([...inRange].sort((a, b) => compareVersions(b.version, a.version)));
}

export function readNotesCache(dir: string = PATHS.data): ReleaseNoteGroup[] {
	const raw = readJson(notesFile(dir));
	return parseGroups(isRecord(raw) ? raw.groups : undefined);
}

/** Merge newer knowledge over the cache (same version: the incoming entry wins), newest 30 kept. */
export function mergeNotesCache(incoming: readonly ReleaseNoteGroup[], dir: string = PATHS.data): void {
	if (incoming.length === 0) return;
	const byVersion = new Map(readNotesCache(dir).map((group) => [group.version, group]));
	for (const group of incoming) byVersion.set(group.version, group);
	const groups = [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version)).slice(0, FEED_NOTES_KEEP);
	fs.mkdirSync(dir, { recursive: true });
	writeFileAtomicSync(notesFile(dir), `${JSON.stringify({ groups }, null, 2)}\n`);
}

export function readUpdateRecord(dir: string = PATHS.data): UpdateRecord {
	const raw = readJson(recordFile(dir));
	if (!isRecord(raw)) return {};
	return {
		...(typeof raw.lastSeenVersion === "string" ? { lastSeenVersion: raw.lastSeenVersion } : {}),
		...(typeof raw.dismissedNotice === "string" ? { dismissedNotice: raw.dismissedNotice } : {}),
	};
}

export function writeUpdateRecord(patch: UpdateRecord, dir: string = PATHS.data): UpdateRecord {
	const next = { ...readUpdateRecord(dir), ...patch };
	fs.mkdirSync(dir, { recursive: true });
	writeFileAtomicSync(recordFile(dir), `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

/**
 * What the popup shows for the running version, or null. A server with no
 * last-seen version (a fresh install, or the first build with this feature)
 * records the running one and shows nothing.
 */
export function whatsNew(running: string, dir: string = PATHS.data): WhatsNew | null {
	if (!isExactVersion(running)) return null;
	const { lastSeenVersion } = readUpdateRecord(dir);
	if (lastSeenVersion === undefined) {
		writeUpdateRecord({ lastSeenVersion: running }, dir);
		return null;
	}
	if (lastSeenVersion === running) return null;
	return { version: running, ...groupsBetween(readNotesCache(dir), lastSeenVersion, running) };
}
