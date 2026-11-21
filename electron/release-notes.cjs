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

const MAX_RELEASE_NOTE_GROUPS = 6;
const MAX_RELEASE_NOTE_ITEMS_PER_GROUP = 8;
const MAX_RELEASE_NOTE_ITEM_LENGTH = 220;
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

function truncateItem(item) {
	if (item.length <= MAX_RELEASE_NOTE_ITEM_LENGTH) return item;
	return `${item.slice(0, MAX_RELEASE_NOTE_ITEM_LENGTH - 3).trimEnd()}...`;
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
		if (plain === "" || /^#{1,6}\s+/.test(plain)) continue;
		if (stats === undefined && /^v\S+ · /.test(plain)) {
			stats = plain.slice(plain.indexOf(" · ") + 3);
			continue;
		}
		if (/^[-*]\s+/.test(line)) items.push(line.replace(/^[-*]\s+/, ""));
		else intro.push(plain);
	}
	return {
		items: items.slice(0, MAX_RELEASE_NOTE_ITEMS_PER_GROUP).map(truncateItem),
		totalItems: items.length + intro.length,
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

// The update feed dates only the offered version; prerelease versions carry their UTC build day.
const PRERELEASE_BUILD_DAY = /-(?:nightly|preview)\.(\d{4})(\d{2})(\d{2})\.\d+$/;

// A date the page can show: YYYY-MM-DD, or an ISO time with a zone. Anything else is dropped.
const RELEASED_AT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const MAX_RELEASED_AT_LENGTH = 40;
function safeReleasedAt(value) {
	return typeof value === "string" && value.length <= MAX_RELEASED_AT_LENGTH && RELEASED_AT.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}

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

function releasedAtOf(version, offeredVersion, releaseDate) {
	if (version === offeredVersion && safeReleasedAt(releaseDate)) return releaseDate;
	const day = PRERELEASE_BUILD_DAY.exec(version);
	return day ? `${day[1]}-${day[2]}-${day[3]}` : undefined;
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
		const note = extractReleaseNoteItems(entry.note);
		if (note.totalItems === 0 && !note.stats) continue;
		seen.add(version);
		const releasedAt = releasedAtOf(version, info.version, info.releaseDate);
		groups.push({ version, ...note, ...(releasedAt ? { releasedAt } : {}) });
	}
	return groups;
}

/**
 * A feed note ({ version, stats?, intro?, items, footer? }) as the summary at
 * the top of its generated release body, T3's format: the "**vX** · stats"
 * header, the intro (bold, as T3 writes a count with no highlights), the
 * "- " items, then "### <footer>". Empty when there is nothing to say.
 */
function summaryBody(note) {
	if (!note || typeof note.version !== "string") return "";
	const text = (value) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");
	const items = Array.isArray(note.items) ? note.items.map(text).filter(Boolean) : [];
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

function capGroups(groups) {
	return {
		releaseNotes: groups.slice(0, MAX_RELEASE_NOTE_GROUPS),
		omittedReleaseCount: Math.max(0, groups.length - MAX_RELEASE_NOTE_GROUPS),
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
	const byVersion = new Map(existing.map((group) => [group.version, group]));
	for (const group of groups) byVersion.set(group.version, group);
	const merged = [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version)).slice(0, NOTES_CACHE_KEEP);
	fs.mkdirSync(dataDir, { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify({ groups: merged }, null, 2)}\n`);
	fs.renameSync(temp, file);
}

const MAX_VERSION_LENGTH = 64;
const MAX_OMITTED_RELEASE_COUNT = 1000;
const MAX_TOTAL_ITEMS = 10000;
// The feed's own bounds (selfhost/src/release.ts FEED_NOTE_LIMITS): longer text is dropped.
const SUMMARY_LIMITS = { intro: 600, stats: 120, footer: 220 };

function boundedText(value, limit) {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/\s+/g, " ");
	return text && text.length <= limit ? text : undefined;
}

/**
 * The notes as the remote page gets them through window.lh.desktopUpdate's
 * status(), polled every 5 s: only the fields it renders (version, releasedAt,
 * items, totalItems, intro, stats, footer), each validated and bounded, at
 * most 6 groups of 8 items.
 */
function bridgeNotes(releaseNotes, omittedReleaseCount) {
	const shown = [];
	for (const group of Array.isArray(releaseNotes) ? releaseNotes : []) {
		if (shown.length >= MAX_RELEASE_NOTE_GROUPS) break;
		if (!group || typeof group.version !== "string" || group.version.length > MAX_VERSION_LENGTH || !VERSION_RE.test(group.version) || !Array.isArray(group.items)) continue;
		const items = group.items
			.filter((item) => typeof item === "string" && item.trim() !== "")
			.slice(0, MAX_RELEASE_NOTE_ITEMS_PER_GROUP)
			.map((item) => truncateItem(item.trim().replace(/\s+/g, " ")));
		const releasedAt = safeReleasedAt(group.releasedAt);
		const summary = {};
		for (const [key, limit] of Object.entries(SUMMARY_LIMITS)) {
			const value = boundedText(group[key], limit);
			if (value) summary[key] = value;
		}
		const total = Number.isInteger(group.totalItems) && group.totalItems >= items.length ? Math.min(group.totalItems, MAX_TOTAL_ITEMS) : items.length + (summary.intro ? 1 : 0);
		shown.push({ version: group.version, ...(releasedAt ? { releasedAt } : {}), items, totalItems: total, ...summary });
	}
	const omitted = Number.isInteger(omittedReleaseCount) && omittedReleaseCount > 0 ? Math.min(omittedReleaseCount, MAX_OMITTED_RELEASE_COUNT) : 0;
	return { releaseNotes: shown, omittedReleaseCount: omitted };
}

module.exports = { releaseNoteGroups, capGroups, mergeNotesCache, extractItems, extractReleaseNoteItems, compareVersions, bridgeNotes, safeReleasedAt, summaryBody, FULL_CHANGELOG_MARKER };
