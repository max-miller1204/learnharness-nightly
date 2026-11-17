"use strict";
/**
 * electron-updater release notes -> ReleaseNoteGroup[] (src/core/release-notes.ts)
 * for the desktop update pill, plus the data folder's notes cache the What's
 * new popup reads (src/server/update-records.ts owns the format; this is its
 * Electron-side writer). docs/specs/t3-style-updates.md, section 4.
 *
 * Ported from T3 Code's apps/desktop/src/updates/releaseNotes.ts
 * (https://github.com/pingdotgg/t3code at 54ad956). Changes: plain
 * CommonJS; T3's intro/stats/footer extras and channel filter dropped (the
 * groups carry items only); "**Label.** detail" bold is kept in the items.
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

function stripMarkup(input) {
	return decodeHtmlEntities(
		input
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<li\b[^>]*>/gi, "\n- ")
			.replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n${"#".repeat(Number(level))} `)
			.replace(/<\/(?:p|div|li|h[1-6]|ul|ol|blockquote)>/gi, "\n")
			.replace(/<\/?(?:strong|b)\b[^>]*>/gi, "**")
			.replace(/<[^>]*>/g, "")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"),
	);
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
		/^full changelog: \S+\.\.\.\S+$/.test(normalized)
	);
}

/** One release body -> its items. Generated notes fold the full list under <details>; cut there. */
function extractItems(note) {
	if (typeof note !== "string" || note === "") return [];
	const summaryEnd = note.search(/<details>\s*<summary>\s*Full changelog\s*<\/summary>/i);
	const body = summaryEnd >= 0 ? note.slice(0, summaryEnd) : note;
	const items = [];
	for (const rawLine of stripMarkup(body).split("\n")) {
		const item = rawLine
			.trim()
			.replace(/^[-*]\s+/, "")
			.replace(/^\d+[.)]\s+/, "")
			.replace(/\s+/g, " ")
			.replace(/\s*\((?:#\d+(?:,\s*)?)+\)\.?$/, "")
			.trim();
		const normalized = normalizeLine(item);
		if (normalized === "new contributors" || normalized === "full changelog") break;
		if (/^#{1,6}\s+/.test(item)) continue;
		if (isIgnoredLine(item)) continue;
		// A summary keeps its order; a long plain list keeps its first items.
		if (items.length < MAX_RELEASE_NOTE_ITEMS_PER_GROUP) items.push(truncateItem(item));
	}
	return items;
}

// The update feed dates only the offered version; prerelease versions carry their UTC build day.
const PRERELEASE_BUILD_DAY = /-(?:nightly|preview)\.(\d{4})(\d{2})(\d{2})\.\d+$/;

function releasedAtOf(version, offeredVersion, releaseDate) {
	if (version === offeredVersion && typeof releaseDate === "string" && releaseDate) return releaseDate;
	const day = PRERELEASE_BUILD_DAY.exec(version);
	return day ? `${day[1]}-${day[2]}-${day[3]}` : undefined;
}

/**
 * Every group electron-updater gave us (newest first), uncapped: the cache
 * keeps them all; the pill caps with capGroups.
 */
function releaseNoteGroups(info) {
	if (!info || typeof info.version !== "string") return [];
	const raw = typeof info.releaseNotes === "string"
		? [{ version: info.version, note: info.releaseNotes }]
		: Array.isArray(info.releaseNotes)
			? info.releaseNotes.filter((entry) => entry && typeof entry.version === "string")
			: [];
	const groups = [];
	const seen = new Set();
	for (const entry of raw) {
		const version = entry.version.replace(/^v/, "");
		if (seen.has(version)) continue;
		const items = extractItems(entry.note);
		if (items.length === 0) continue;
		seen.add(version);
		const releasedAt = releasedAtOf(version, info.version, info.releaseDate);
		groups.push({ version, ...(releasedAt ? { releasedAt } : {}), items });
	}
	return groups;
}

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

module.exports = { releaseNoteGroups, capGroups, mergeNotesCache, extractItems, compareVersions };
