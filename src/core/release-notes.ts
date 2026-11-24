/**
 * Release notes as the update pill and the What's new popup show them
 * (docs/specs/t3-style-updates.md). The shape and limits are T3 Code's
 * DesktopUpdateReleaseNote (packages/contracts/src/ipc.ts:297-308 at
 * df09ced7) and apps/desktop/src/updates/releaseNotes.ts: at most 6 groups,
 * 8 items per group, 220 characters per item. Client-safe: no Node imports.
 */
import { noteReleasedAt as sharedNoteReleasedAt } from "../../electron/release-dates.cjs";

/** One version's notes. Items are plain sentences; `**Label.** detail` renders the label bold. */
export interface ReleaseNoteGroup {
	version: string;
	/** ISO time from the feed, or YYYY-MM-DD from a nightly's build day, when known. */
	releasedAt?: string;
	items: string[];
	/** How many changes the release has, items cut by the limits included ("N more changes on GitHub"). Defaults to the items, plus the intro. */
	totalItems?: number;
	/** A generated summary's paragraph, shown instead of the items (T3: "**3 bug fixes.**" with no highlights). */
	intro?: string;
	/** A generated summary's counts, for example "12 changes from 2 contributors": the release link's label. */
	stats?: string;
	/** A generated summary's last line, for example "Plus 3 more bug fixes.". */
	footer?: string;
}

const normalized = (text: string | undefined) => (text ?? "").trim().replace(/\s+/g, " ");

/** Whether `item` is `text`, as written or as the item limits cut it (a 600-character intro's copy is cut to 220). */
function isCopyOf(item: string, text: string | undefined): boolean {
	if (text === undefined) return false;
	const whole = normalized(text);
	return whole !== "" && (item === whole || item === truncateReleaseNoteItem(whole));
}

/**
 * Old clients read only `items`, so the release script also writes the intro or footer once more
 * as the last item (scripts/generate-release-notes.ts entryItems). Every stored or sent copy of the
 * notes keeps it, for old readers; what a new client shows drops it: only that one trailing item,
 * compared as the full text with both sides normalized, never another bullet.
 *
 * The copy is last, so the item limits cut it off first. A full list (the cap) whose whole count,
 * less the intro, equals its length holds only real items: the copy was the one that fell off, so a
 * last item reading like the footer is a real highlight and stays. Any other count (none, or one
 * above the list) leaves the last item the copy, as it is for every shorter list. The release script
 * writes at most 7 highlights before the copy (MAX_HIGHLIGHTS), so its own output is never full
 * without it; a feed with more real items than the cap whose last shown one reads like the footer
 * cannot be told from the copy and is read as the copy.
 */
export function withoutSummaryEcho(items: readonly string[], { intro, footer, totalItems }: { intro?: string; footer?: string; totalItems?: number }): string[] {
	const last = items.length > 0 ? normalized(items[items.length - 1]) : "";
	const matches = last !== "" && (isCopyOf(last, footer) || isCopyOf(last, intro));
	const copyWasCut = items.length >= MAX_RELEASE_NOTE_ITEMS && isCount(totalItems) && totalItems - (intro ? 1 : 0) === items.length;
	return matches && !copyWasCut ? items.slice(0, -1) : [...items];
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** The release's whole count: what the feed said, else the shown items and the intro (T3's totalItems). */
export const totalReleaseItems = (group: ReleaseNoteGroup): number => {
	const shown = withoutSummaryEcho(group.items, group).length;
	return isCount(group.totalItems)
		? Math.max(group.totalItems, shown)
		: shown + (group.intro ? 1 : 0);
};

export const MAX_RELEASE_NOTE_GROUPS = 6;
export const MAX_RELEASE_NOTE_ITEMS = 8;
export const MAX_RELEASE_NOTE_ITEM_LENGTH = 220;

export function truncateReleaseNoteItem(item: string): string {
	const clean = item.trim().replace(/\s+/g, " ");
	if (clean.length <= MAX_RELEASE_NOTE_ITEM_LENGTH) return clean;
	return `${clean.slice(0, MAX_RELEASE_NOTE_ITEM_LENGTH - 3).trimEnd()}...`;
}

/** The update feed's pointer: the version it offers and when that release was published. */
export interface OfferedRelease {
	version: string;
	releasedAt?: unknown;
}

/**
 * A note's date, the same on every surface: the note's own time when it is readable; for the offered
 * version, else the pointer's time when that is readable (T3's resolveReleasedAt); else the
 * nightly's UTC build day from its version; else none. One implementation, shared with the desktop's
 * note reader (electron/release-dates.cjs).
 */
export const noteReleasedAt: (own: unknown, version: string, offered?: OfferedRelease) => string | undefined = sharedNoteReleasedAt;

/** Cap a newest-first list to what the UI shows; the rest is counted. */
export function capReleaseNoteGroups(groups: readonly ReleaseNoteGroup[]): { releaseNotes: ReleaseNoteGroup[]; omittedReleaseCount: number } {
	const shown = groups.slice(0, MAX_RELEASE_NOTE_GROUPS).map((group) => ({
		...group,
		totalItems: totalReleaseItems(group),
		items: group.items.slice(0, MAX_RELEASE_NOTE_ITEMS).map(truncateReleaseNoteItem),
	}));
	return { releaseNotes: shown, omittedReleaseCount: Math.max(0, groups.length - MAX_RELEASE_NOTE_GROUPS) };
}
