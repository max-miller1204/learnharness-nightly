/**
 * Release notes as the update pill and the What's new popup show them
 * (docs/specs/t3-style-updates.md). The shape and limits are T3 Code's
 * DesktopUpdateReleaseNote (packages/contracts/src/ipc.ts:297-308 at
 * df09ced7) and apps/desktop/src/updates/releaseNotes.ts: at most 6 groups,
 * 8 items per group, 220 characters per item. Client-safe: no Node imports.
 */

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
 */
export function withoutSummaryEcho(items: readonly string[], { intro, footer }: { intro?: string; footer?: string }): string[] {
	const last = items.length > 0 ? normalized(items[items.length - 1]) : "";
	const echoes = last !== "" && (isCopyOf(last, footer) || isCopyOf(last, intro));
	return echoes ? items.slice(0, -1) : [...items];
}

/** The release's whole count: what the feed said, else the shown items and the intro (T3's totalItems). */
export const totalReleaseItems = (group: ReleaseNoteGroup): number => {
	const shown = withoutSummaryEcho(group.items, group).length;
	return typeof group.totalItems === "number" && Number.isInteger(group.totalItems) && group.totalItems >= 0
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

// A date the page can show: YYYY-MM-DD, or an ISO time with a zone (electron/release-notes.cjs safeReleasedAt).
const RELEASED_AT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const PRERELEASE_BUILD_DAY = /-(?:nightly|preview)\.(\d{4})(\d{2})(\d{2})\.\d+$/;

/** A note's date, the same on every surface: the feed's own time when it gives a valid one, else the
 *  nightly's UTC build day from its version (T3's fallback), else none. */
export function noteReleasedAt(value: unknown, version: string): string | undefined {
	if (typeof value === "string" && value.length <= 40 && RELEASED_AT.test(value) && Number.isFinite(Date.parse(value))) return value;
	const day = PRERELEASE_BUILD_DAY.exec(version);
	return day ? `${day[1]}-${day[2]}-${day[3]}` : undefined;
}

/** Cap a newest-first list to what the UI shows; the rest is counted. */
export function capReleaseNoteGroups(groups: readonly ReleaseNoteGroup[]): { releaseNotes: ReleaseNoteGroup[]; omittedReleaseCount: number } {
	const shown = groups.slice(0, MAX_RELEASE_NOTE_GROUPS).map((group) => ({
		...group,
		totalItems: totalReleaseItems(group),
		items: group.items.slice(0, MAX_RELEASE_NOTE_ITEMS).map(truncateReleaseNoteItem),
	}));
	return { releaseNotes: shown, omittedReleaseCount: Math.max(0, groups.length - MAX_RELEASE_NOTE_GROUPS) };
}
