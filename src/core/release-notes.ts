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

/** Old clients read only `items`, so the release script also writes the intro or footer as the
 *  last item (scripts/generate-release-notes.ts entryItems); a client that reads those fields drops
 *  that copy. */
export function withoutSummaryEcho(items: readonly string[], { intro, footer }: { intro?: string; footer?: string }): string[] {
	return items.filter((item) => item !== intro && item !== footer);
}

/** The release's whole count: what the feed said, else the items and the intro (T3's totalItems). */
export const totalReleaseItems = (group: ReleaseNoteGroup): number =>
	typeof group.totalItems === "number" && Number.isInteger(group.totalItems) && group.totalItems >= 0
		? Math.max(group.totalItems, group.items.length)
		: group.items.length + (group.intro ? 1 : 0);

export const MAX_RELEASE_NOTE_GROUPS = 6;
export const MAX_RELEASE_NOTE_ITEMS = 8;
export const MAX_RELEASE_NOTE_ITEM_LENGTH = 220;

export function truncateReleaseNoteItem(item: string): string {
	const clean = item.trim().replace(/\s+/g, " ");
	if (clean.length <= MAX_RELEASE_NOTE_ITEM_LENGTH) return clean;
	return `${clean.slice(0, MAX_RELEASE_NOTE_ITEM_LENGTH - 3).trimEnd()}...`;
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
