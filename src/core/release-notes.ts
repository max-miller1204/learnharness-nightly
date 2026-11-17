/**
 * Release notes as the update pill and the What's new popup show them
 * (docs/specs/t3-style-updates.md). Limits are T3 Code's
 * (apps/desktop/src/updates/releaseNotes.ts): at most 6 groups, 8 items per
 * group, 220 characters per item. Client-safe: no Node imports.
 */

/** One version's notes. Items are plain sentences; `**Label.** detail` renders the label bold. */
export interface ReleaseNoteGroup {
	version: string;
	/** ISO time or YYYY-MM-DD, when known. */
	releasedAt?: string;
	items: string[];
}

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
		items: group.items.slice(0, MAX_RELEASE_NOTE_ITEMS).map(truncateReleaseNoteItem),
	}));
	return { releaseNotes: shown, omittedReleaseCount: Math.max(0, groups.length - MAX_RELEASE_NOTE_GROUPS) };
}
