"use strict";
/**
 * electron-updater release notes -> ReleaseNoteGroup[] (src/core/release-notes.ts)
 * for the desktop update pill, plus the data folder's notes cache the What's
 * new popup reads (src/server/update-records.ts owns the format; this is its
 * Electron-side writer). docs/specs/t3-style-updates.md, section 4.
 *
 * Ported from T3 Code's apps/desktop/src/updates/releaseNotes.ts
 * (https://github.com/pingdotgg/t3code at df09ced7): stripMarkup,
 * extractReleaseNoteSummary (a generated body's stats, intro, items and
 * footer), extractReleaseNoteItems (a plain list: its newest 8, with the
 * whole count), resolveReleasedAt and releaseNotesOfOfferedVersion.
 * Changes: plain CommonJS; no channel filter (one channel); items are cut
 * to 8 of 220 characters in a summary too (the pill's limits); a version's
 * leading "v" is dropped and a version appears once. summaryBody writes the
 * generated body T3's scripts/generate-release-notes.ts writes
 * (buildReleaseHeader, formatReleaseSummary, assembleReleaseNotes), so the
 * release page and the desktop read one format.
 * T3 Code carries this notice:
 *
 *   MIT License
 *
 *   Copyright (c) 2026 T3 Tools Inc.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */
const fs = require("node:fs");
const path = require("node:path");
const { readableReleasedAt, noteReleasedAt } = require("./release-dates.cjs");
const {
	MAX_RELEASE_NOTE_GROUPS,
	MAX_RELEASE_NOTE_ITEMS: MAX_RELEASE_NOTE_ITEMS_PER_GROUP,
	MAX_NOTE_VERSION_LENGTH,
	MAX_OMITTED_RELEASE_COUNT,
	MAX_TOTAL_ITEMS,
	SUMMARY_LIMITS,
	cleanNoteText: cleanText,
	boundedNoteText: boundedText,
	sliceReleaseNoteItem: truncateItem,
	endsWithSummaryCopy,
	stripTrailingSummaryEcho: withoutSummaryEcho,
} = require("./release-note-rules.cjs");

const NOTES_CACHE_KEEP = 30;

const HTML_ENTITY_REPLACEMENTS = new Map([
	["amp", "&"],
	["apos", "'"],
	["gt", ">"],
	["lt", "<"],
	["nbsp", " "],
	["quot", '"'],
]);

function decodeCodePoint(codePoint, entity) {
	if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return `&${entity};`;
	return String.fromCodePoint(codePoint);
}

function decodeHtmlEntity(entity) {
	const named = HTML_ENTITY_REPLACEMENTS.get(entity);
	if (named) return named;
	if (entity.startsWith("#x")) return decodeCodePoint(Number.parseInt(entity.slice(2), 16), entity);
	if (entity.startsWith("#")) return decodeCodePoint(Number.parseInt(entity.slice(1), 10), entity);
	return `&${entity};`;
}

function decodeHtmlEntities(input) {
	return input.replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (_, entity) => decodeHtmlEntity(entity));
}

function stripMarkup(input, keepBold = false) {
	const markdown = decodeHtmlEntities(
		input
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<li\b[^>]*>/gi, "\n- ")
			.replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n${"#".repeat(Number(level))} `)
			.replace(/<\/(?:p|div|li|h[1-6]|ul|ol|blockquote)>/gi, "\n")
			.replace(/<\/?(?:strong|b)\b[^>]*>/gi, "**")
			.replace(/<[^>]*>/g, "")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"),
	);
	return keepBold ? markdown : markdown.replace(/\*\*([^*]+)\*\*/g, "$1");
}

function normalizeLine(line) {
	return line.toLowerCase().replace(/[*_`#]/g, "").trim();
}

function isIgnoredLine(line) {
	const normalized = normalizeLine(line);
	return (
		normalized === "" ||
		normalized === "what's changed" ||
		normalized === "whats changed" ||
		normalized.startsWith("compare: ") ||
		normalized.includes("/compare/") ||
		// The feed's HTML footer loses its compare URL to stripMarkup, leaving only the range.
		/^full changelog: \S+\.\.\.\S+$/.test(normalized)
	);
}

/** A generated summary: "**vX** · stats", an intro paragraph or "- " items, "### Plus N more ...". */
function extractReleaseNoteSummary(summary) {
	let stats;
	let footer;
	const intro = [];
	const items = [];
	for (const rawLine of stripMarkup(summary, true).split("\n")) {
		const line = rawLine
			.trim()
			.replace(/\s+/g, " ")
			.replace(/\s*\((?:#\d+(?:,\s*)?)+\)\.?$/, "")
			.trim();
		const plain = line.replace(/\*\*([^*]+)\*\*/g, "$1");
		if (/^### Plus \d+ more /.test(plain)) {
			footer = plain.slice(4);
			continue;
		}
		// Any other "### " line after the summary's text is its footer too (summaryBody writes one
		// for every footer); a heading before it, such as "### What's changed", is skipped as in T3.
		if (/^###\s+\S/.test(plain) && (items.length > 0 || intro.length > 0 || stats !== undefined)) {
			footer = plain.replace(/^###\s+/, "");
			continue;
		}
		if (plain === "" || /^#{1,6}\s+/.test(plain)) continue;
		if (stats === undefined && /^v\S+ · /.test(plain)) {
			stats = plain.slice(plain.indexOf(" · ") + 3);
			continue;
		}
		if (/^[-*]\s+/.test(line)) items.push(line.replace(/^[-*]\s+/, ""));
		else intro.push(plain);
	}
	const shown = items.slice(0, MAX_RELEASE_NOTE_ITEMS_PER_GROUP).map(truncateItem);
	const introText = intro.length > 0 ? intro.join(" ") : undefined;
	return {
		items: shown,
		totalItems: items.length + intro.length,
		// A generated body lists real items only: a full list ending like its footer ends in a real item.
		...(shown.length === MAX_RELEASE_NOTE_ITEMS_PER_GROUP && endsWithSummaryCopy(shown, { intro: introText, footer }) ? { summaryCopy: false } : {}),
		...(intro.length > 0 ? { intro: intro.join(" ") } : {}),
		...(stats ? { stats } : {}),
		...(footer ? { footer } : {}),
	};
}

/** One release body -> its items. Generated notes fold the full list under <details>; cut there. */
function extractReleaseNoteItems(note) {
	if (typeof note !== "string" || note === "") return { items: [], totalItems: 0 };
	// Generated summaries fold GitHub's full list under this exact <details> block.
	const summaryEnd = note.search(/<details>\s*<summary>\s*Full changelog\s*<\/summary>/i);
	if (summaryEnd >= 0) return extractReleaseNoteSummary(note.slice(0, summaryEnd));
	const items = [];
	let totalItems = 0;
	for (const rawLine of stripMarkup(note).split("\n")) {
		const item = rawLine
			.trim()
			.replace(/^[-*]\s+/, "")
			.replace(/^\d+[.)]\s+/, "")
			.replace(/\s+/g, " ");
		const normalized = normalizeLine(item);
		if (normalized === "new contributors" || normalized === "full changelog") break;
		if (/^#{1,6}\s+/.test(item)) continue;
		if (isIgnoredLine(item)) continue;
		totalItems += 1;
		items.push(truncateItem(item));
		if (items.length > MAX_RELEASE_NOTE_ITEMS_PER_GROUP) items.shift();
	}
	// GitHub lists a release's changes oldest first: its newest 8, newest first.
	return { items: items.reverse(), totalItems };
}

/** The items of a release body (the pill's and the cache's view of one note). */
function extractItems(note) {
	return extractReleaseNoteItems(note).items;
}

// How a note is dated is shared with the server and the pages (electron/release-dates.cjs).
const safeReleasedAt = readableReleasedAt;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Untagged notes come from the feed entry named by releaseName, which is the newest entry when the
 * offered release is not on the feed's first page. Keep them only when that entry is the offered one.
 */
function releaseNotesOfOfferedVersion(info) {
	if (typeof info.releaseNotes !== "string" || !info.releaseName) return info.releaseNotes;
	const namesVersion = new RegExp(`(?:^|[^\\w.-])v?${escapeRegExp(info.version)}(?![\\w.-])`);
	return namesVersion.test(info.releaseName) ? info.releaseNotes : undefined;
}

/**
 * Every group electron-updater gave us (newest first), uncapped: the cache
 * keeps them all; the pill caps with capGroups.
 */
function releaseNoteGroups(info) {
	if (!info || typeof info.version !== "string") return [];
	const releaseNotes = releaseNotesOfOfferedVersion(info);
	const raw = typeof releaseNotes === "string"
		? [{ version: info.version, note: releaseNotes }]
		: Array.isArray(releaseNotes)
			? releaseNotes.filter((entry) => entry && typeof entry.version === "string" && (typeof entry.note === "string" || entry.note == null))
			: [];
	const groups = [];
	const seen = new Set();
	for (const entry of raw) {
		const version = entry.version.replace(/^v/, "");
		if (seen.has(version)) continue;
		// A feed note (electron/nightly-updater.cjs) is already structured: its fields as they are,
		// never through Markdown, where item text like "<br>" or "- x" would change shape.
		const note = Array.isArray(entry.items) ? feedNoteFields(entry) : extractReleaseNoteItems(entry.note);
		// T3 drops a release with nothing to show; a footer alone is something.
		if (note.totalItems === 0 && !note.stats && !note.footer) continue;
		seen.add(version);
		// A feed note carries its own publish time (the server reads the same one). noteReleasedAt is the
		// rule the server and the pages use: the note's time, the pointer's for the offered version, the build day.
		const releasedAt = noteReleasedAt(entry.releasedAt, version, { version: info.version, releasedAt: info.releaseDate });
		groups.push({ version, ...note, ...(releasedAt ? { releasedAt } : {}) });
	}
	return groups;
}

/**
 * The decision for a full list that ends like the copy: true when the whole list is that list (the
 * copy is last), false when `whole` is longer (the cut took the copy off). Nothing for any other list.
 */
function wholeListCopy(whole, shown, summary) {
	const cut = shown.slice(0, MAX_RELEASE_NOTE_ITEMS_PER_GROUP);
	return cut.length === MAX_RELEASE_NOTE_ITEMS_PER_GROUP && endsWithSummaryCopy(cut, summary) ? { summaryCopy: whole.length === MAX_RELEASE_NOTE_ITEMS_PER_GROUP } : {};
}

/** A feed note's own fields (latest.json notes, selfhost/src/release.ts FeedNote). */
function feedNoteFields(entry) {
	const summary = {};
	for (const [key, limit] of Object.entries(SUMMARY_LIMITS)) {
		const value = boundedText(entry[key], limit);
		if (value) summary[key] = value;
	}
	const items = entry.items.filter((item) => typeof item === "string").map(cleanText).filter(Boolean);
	return { items, totalItems: withoutSummaryEcho(items, summary).length + (summary.intro ? 1 : 0), ...wholeListCopy(items, items, summary), ...summary };
}

/**
 * A feed note ({ version, stats?, intro?, items, footer? }) as the summary at
 * the top of its generated release body, T3's format: the "**vX** · stats"
 * header, the intro (bold, as T3 writes a count with no highlights), the
 * "- " items, then "### <footer>". Empty when there is nothing to say.
 */
/**
 * Note text made safe for the body: GitHub shows these entities as the characters, and the parser
 * above decodes them only after its tag, line-break and link rules ran (stripMarkup), so an item
 * reading "Keep <br> in exports." or "[x](y)" comes back exactly as written.
 */
const escapeBodyText = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;");

function summaryBody(note) {
	if (!note || typeof note.version !== "string") return "";
	const text = (value) => escapeBodyText(cleanText(value));
	const items = withoutSummaryEcho(Array.isArray(note.items) ? note.items.map(text).filter(Boolean) : [], { intro: text(note.intro), footer: text(note.footer) });
	const parts = [];
	if (text(note.stats)) parts.push(`**v${note.version.replace(/^v/, "")}** · ${text(note.stats)}`);
	if (text(note.intro)) parts.push(`**${text(note.intro)}**`);
	if (items.length > 0) parts.push(items.map((item) => `- ${item}`).join("\n"));
	if (text(note.footer)) parts.push(`### ${text(note.footer)}`);
	return parts.join("\n\n");
}

/** The marker after a summary: clients cut a body at <details> (T3's assembleReleaseNotes). */
const FULL_CHANGELOG_MARKER = "<details>\n<summary>Full changelog</summary>\n</details>";

// Same shape and order as selfhost/src/release.ts compareVersions; unknown shapes sort last.
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d{8})\.(\d+))?$/;
function compareVersions(a, b) {
	const pa = VERSION_RE.exec(a);
	const pb = VERSION_RE.exec(b);
	if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
	for (const i of [1, 2, 3]) {
		const d = Number(pa[i]) - Number(pb[i]);
		if (d !== 0) return d;
	}
	if (!pa[4] && pb[4]) return 1;
	if (pa[4] && !pb[4]) return -1;
	if (!pa[4] || !pb[4]) return 0;
	const date = Number(pa[5]) - Number(pb[5]);
	if (date !== 0) return date;
	return Number(pa[6]) - Number(pb[6]);
}

const isExactVersion = (version) => typeof version === "string" && VERSION_RE.test(version);
const isNewerVersion = (a, b) => isExactVersion(a) && isExactVersion(b) && compareVersions(a, b) > 0;
const releaseTrack = (version) => {
	const match = typeof version === "string" ? VERSION_RE.exec(version) : null;
	return match ? (match[4] ?? "") : null;
};
const sameReleaseTrack = (a, b) => {
	const track = releaseTrack(a);
	return track !== null && track === releaseTrack(b);
};

/** What main keeps for the local window: the first 6 shown groups, bounded, and how many more. */
function capGroups(groups) {
	const shown = (Array.isArray(groups) ? groups : []).map(boundedGroup).filter(Boolean);
	return {
		releaseNotes: shown.slice(0, MAX_RELEASE_NOTE_GROUPS),
		omittedReleaseCount: Math.min(Math.max(0, shown.length - MAX_RELEASE_NOTE_GROUPS), MAX_OMITTED_RELEASE_COUNT),
	};
}

/** Merge groups into <dataDir>/release-notes.json (same version: incoming wins), newest 30 kept. Best effort. */
function mergeNotesCache(dataDir, groups) {
	if (!Array.isArray(groups) || groups.length === 0) return;
	const file = path.join(dataDir, "release-notes.json");
	let existing = [];
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (parsed && Array.isArray(parsed.groups)) existing = parsed.groups.filter((g) => g && typeof g.version === "string" && Array.isArray(g.items));
	} catch {
		/* no cache yet */
	}
	const byVersion = new Map(existing.map(boundedGroup).filter(Boolean).map((group) => [group.version, group]));
	for (const group of groups.map(boundedGroup).filter(Boolean)) byVersion.set(group.version, group);
	const merged = [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version)).slice(0, NOTES_CACHE_KEEP);
	fs.mkdirSync(dataDir, { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify({ groups: merged }, null, 2)}\n`);
	fs.renameSync(temp, file);
}

/**
 * One group as every reader may keep it (main's state for the local window,
 * the notes cache, the remote page): a valid version, the rendered fields
 * only, each bounded. Null when the group can't be shown.
 */
function boundedGroup(group) {
	if (!group || typeof group.version !== "string" || group.version.length > MAX_NOTE_VERSION_LENGTH || !VERSION_RE.test(group.version) || !Array.isArray(group.items)) return null;
	const summary = {};
	for (const [key, limit] of Object.entries(SUMMARY_LIMITS)) {
		const value = boundedText(group[key], limit);
		if (value) summary[key] = value;
	}
	// The old-client copy stays in the items; it's compared (and left out of the count) at full length.
	const all = group.items.filter((item) => typeof item === "string").map(cleanText).filter(Boolean);
	const items = all.slice(0, MAX_RELEASE_NOTE_ITEMS_PER_GROUP).map(truncateItem);
	const counted = withoutSummaryEcho(all, summary).length + (summary.intro ? 1 : 0);
	const totalItems = Number.isInteger(group.totalItems) && group.totalItems >= items.length ? Math.min(group.totalItems, MAX_TOTAL_ITEMS) : counted;
	const releasedAt = safeReleasedAt(group.releasedAt);
	// The copy is last only while the list is whole: the cut above takes it off the end. A recorded
	// decision is kept as it is (this runs again over main's cut output, the cache and the bridge); a
	// group with none, stored before the field, stays without one.
	const summaryCopy = typeof group.summaryCopy === "boolean" ? group.summaryCopy && all.length <= MAX_RELEASE_NOTE_ITEMS_PER_GROUP : undefined;
	return { version: group.version, ...(releasedAt ? { releasedAt } : {}), items, totalItems, ...summary, ...(summaryCopy === undefined ? {} : { summaryCopy }) };
}

/**
 * The notes as the remote page gets them through window.lh.desktopUpdate's
 * status(), polled every 5 s: only the fields it renders (version, releasedAt,
 * items, totalItems, intro, stats, footer), each validated and bounded, at
 * most 6 groups of 8 items.
 */
function bridgeNotes(releaseNotes, omittedReleaseCount) {
	const shown = (Array.isArray(releaseNotes) ? releaseNotes : []).map(boundedGroup).filter(Boolean).slice(0, MAX_RELEASE_NOTE_GROUPS);
	const omitted = Number.isInteger(omittedReleaseCount) && omittedReleaseCount > 0 ? Math.min(omittedReleaseCount, MAX_OMITTED_RELEASE_COUNT) : 0;
	return { releaseNotes: shown, omittedReleaseCount: omitted };
}

module.exports = { releaseNoteGroups, capGroups, mergeNotesCache, extractItems, extractReleaseNoteItems, compareVersions, isExactVersion, isNewerVersion, releaseTrack, sameReleaseTrack, bridgeNotes, boundedGroup, safeReleasedAt, summaryBody, FULL_CHANGELOG_MARKER };
