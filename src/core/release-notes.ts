/**
 * Release notes as the update pill and the What's new popup show them
 * (docs/specs/t3-style-updates.md). The shape and limits are T3 Code's
 * DesktopUpdateReleaseNote (packages/contracts/src/ipc.ts:297-308 at
 * df09ced7) and apps/desktop/src/updates/releaseNotes.ts: at most 6 groups,
 * 8 items per group, 220 characters per item. Client-safe: no Node imports.
 */
import { MAX_RELEASED_AT_LENGTH, noteReleasedAt as sharedNoteReleasedAt } from "../../electron/release-dates.cjs";
import {
	MAX_RELEASE_NOTE_GROUPS as SHARED_MAX_GROUPS,
	MAX_RELEASE_NOTE_ITEMS as SHARED_MAX_ITEMS,
	MAX_RELEASE_NOTE_ITEM_LENGTH as SHARED_MAX_ITEM_LENGTH,
	MAX_NOTE_VERSION_LENGTH as SHARED_MAX_VERSION_LENGTH,
	MAX_OMITTED_RELEASE_COUNT as SHARED_MAX_OMITTED,
	MAX_TOTAL_ITEMS as SHARED_MAX_TOTAL_ITEMS,
	SUMMARY_LIMITS as SHARED_SUMMARY_LIMITS,
	truncateReleaseNoteItem as sharedTruncateItem,
	endsWithSummaryCopy as sharedEndsWithSummaryCopy,
	withoutSummaryEcho as sharedWithoutSummaryEcho,
	totalReleaseItems as sharedTotalReleaseItems,
} from "../../electron/release-note-rules.cjs";

export { MAX_RELEASED_AT_LENGTH };

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
	/**
	 * Whether the last of `items` is the old-client copy of the intro or footer (true), or a real item
	 * (false). Decided where the whole list is known, before the item limits cut it, and carried
	 * through every later copy of the group. Absent in groups stored before it existed: see withoutSummaryEcho.
	 */
	summaryCopy?: boolean;
}

export const MAX_RELEASE_NOTE_GROUPS: number = SHARED_MAX_GROUPS;
export const MAX_RELEASE_NOTE_ITEMS: number = SHARED_MAX_ITEMS;
export const MAX_RELEASE_NOTE_ITEM_LENGTH: number = SHARED_MAX_ITEM_LENGTH;
export const MAX_NOTE_VERSION_LENGTH: number = SHARED_MAX_VERSION_LENGTH;
export const MAX_OMITTED_RELEASE_COUNT: number = SHARED_MAX_OMITTED;
export const MAX_TOTAL_ITEMS: number = SHARED_MAX_TOTAL_ITEMS;
export const SUMMARY_LIMITS: Readonly<{ intro: number; stats: number; footer: number }> = SHARED_SUMMARY_LIMITS;

export const endsWithSummaryCopy: (items: readonly string[], summary: { intro?: string; footer?: string }) => boolean = sharedEndsWithSummaryCopy;
export const withoutSummaryEcho: (items: readonly string[], summary: { intro?: string; footer?: string; totalItems?: number; summaryCopy?: boolean }) => string[] = sharedWithoutSummaryEcho;
export const totalReleaseItems: (group: ReleaseNoteGroup) => number = sharedTotalReleaseItems;
export const truncateReleaseNoteItem: (item: string) => string = sharedTruncateItem;

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
		// A cut takes the copy off the end first: nothing left of it.
		...(group.items.length > MAX_RELEASE_NOTE_ITEMS && group.summaryCopy !== undefined ? { summaryCopy: false } : {}),
		items: group.items.slice(0, MAX_RELEASE_NOTE_ITEMS).map(truncateReleaseNoteItem),
	}));
	return { releaseNotes: shown, omittedReleaseCount: Math.max(0, groups.length - MAX_RELEASE_NOTE_GROUPS) };
}
