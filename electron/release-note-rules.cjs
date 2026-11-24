"use strict";
/**
 * Release-note bounds and summary-copy rules shared by Electron
 * (electron/release-notes.cjs), the server (src/server/update-records.ts), and
 * the web app (src/core/release-notes.ts, components/settings/update-settings.tsx).
 * Plain CommonJS with no imports so Electron's asar and Next's client/server
 * bundles load the same file.
 */

const MAX_RELEASE_NOTE_GROUPS = 6;
const MAX_RELEASE_NOTE_ITEMS = 8;
const MAX_RELEASE_NOTE_ITEM_LENGTH = 220;
const MAX_NOTE_VERSION_LENGTH = 64;
const MAX_OMITTED_RELEASE_COUNT = 1000;
const MAX_TOTAL_ITEMS = 10000;
const SUMMARY_LIMITS = { intro: 600, stats: 120, footer: 220 };

const isCount = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** @param {unknown} value @returns {string} */
function cleanNoteText(value) {
	return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/** @param {unknown} value @param {number} limit @returns {string | undefined} */
function boundedNoteText(value, limit) {
	const text = cleanNoteText(value);
	return text && text.length <= limit ? text : undefined;
}

/** @param {string} item @returns {string} */
function truncateReleaseNoteItem(item) {
	const clean = cleanNoteText(item);
	if (clean.length <= MAX_RELEASE_NOTE_ITEM_LENGTH) return clean;
	return `${clean.slice(0, MAX_RELEASE_NOTE_ITEM_LENGTH - 3).trimEnd()}...`;
}

/** @param {string} item @param {string | undefined} text @returns {boolean} */
function isCopyOf(item, text) {
	if (text === undefined) return false;
	const whole = cleanNoteText(text);
	return whole !== "" && (item === whole || item === truncateReleaseNoteItem(whole));
}

/** @param {readonly string[]} items @param {{ intro?: string; footer?: string }} [summary] @returns {boolean} */
function endsWithSummaryCopy(items, { intro, footer } = {}) {
	const last = items.length > 0 ? cleanNoteText(items[items.length - 1]) : "";
	return last !== "" && (isCopyOf(last, footer) || isCopyOf(last, intro));
}

/**
 * Old clients read only `items`, so the release script also writes the intro or footer once more
 * as the last item. Every stored or sent copy keeps it for old readers; new clients drop that one
 * trailing item. When `summaryCopy` is recorded it is authoritative; otherwise a full list whose
 * whole count (minus intro) equals its length keeps every item.
 *
 * @param {readonly string[]} items
 * @param {{ intro?: string; footer?: string; totalItems?: number; summaryCopy?: boolean }} [summary]
 * @returns {string[]}
 */
function withoutSummaryEcho(items, { intro, footer, totalItems, summaryCopy } = {}) {
	if (!endsWithSummaryCopy(items, { intro, footer })) return [...items];
	const copy = typeof summaryCopy === "boolean"
		? summaryCopy
		: !(items.length >= MAX_RELEASE_NOTE_ITEMS && isCount(totalItems) && totalItems - (intro ? 1 : 0) === items.length);
	return copy ? items.slice(0, -1) : [...items];
}

/** @param {{ items: readonly string[]; intro?: string; footer?: string; totalItems?: number; summaryCopy?: boolean }} group @returns {number} */
function totalReleaseItems(group) {
	const shown = withoutSummaryEcho(group.items, group).length;
	return isCount(group.totalItems)
		? Math.max(group.totalItems, shown)
		: shown + (group.intro ? 1 : 0);
}

module.exports = {
	MAX_RELEASE_NOTE_GROUPS,
	MAX_RELEASE_NOTE_ITEMS,
	MAX_RELEASE_NOTE_ITEM_LENGTH,
	MAX_NOTE_VERSION_LENGTH,
	MAX_OMITTED_RELEASE_COUNT,
	MAX_TOTAL_ITEMS,
	SUMMARY_LIMITS,
	cleanNoteText,
	boundedNoteText,
	truncateReleaseNoteItem,
	isCopyOf,
	endsWithSummaryCopy,
	withoutSummaryEcho,
	totalReleaseItems,
};
