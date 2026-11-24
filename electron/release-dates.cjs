"use strict";
/**
 * How a release note is dated, for every reader of the notes: the desktop's note reader
 * (electron/release-notes.cjs) and, through src/core/release-notes.ts, the server and the pages.
 * Plain CommonJS with no imports, so the Electron shell (whose asar holds only electron/) and the
 * Next server and client bundles load the same file.
 */

// A date the page can show: YYYY-MM-DD, or an ISO time with a zone. Anything else is dropped.
const RELEASED_AT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const MAX_RELEASED_AT_LENGTH = 40;
// The update feed dates only the offered version; prerelease versions carry their UTC build day.
const PRERELEASE_BUILD_DAY = /-(?:nightly|preview)\.(\d{4})(\d{2})(\d{2})\.\d+$/;

/**
 * The value when it is a time the page can show and Date can read, else undefined.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function readableReleasedAt(value) {
	return typeof value === "string" && value.length <= MAX_RELEASED_AT_LENGTH && RELEASED_AT.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/**
 * A nightly's UTC build day (YYYY-MM-DD) from its version, else undefined.
 * @param {string} version
 * @returns {string | undefined}
 */
function buildDayOf(version) {
	const day = PRERELEASE_BUILD_DAY.exec(version);
	return day ? `${day[1]}-${day[2]}-${day[3]}` : undefined;
}

/**
 * A note's date: its own time when readable; for the offered version, else the feed pointer's time
 * when readable (T3's resolveReleasedAt); else the build day from its version; else undefined.
 * @param {unknown} own the time the note carries
 * @param {string} version the note's version
 * @param {{ version: string, releasedAt?: unknown }} [offered] the feed pointer: the offered version and its time
 * @returns {string | undefined}
 */
function noteReleasedAt(own, version, offered) {
	return readableReleasedAt(own) ?? (offered && offered.version === version ? readableReleasedAt(offered.releasedAt) : undefined) ?? buildDayOf(version);
}

module.exports = { MAX_RELEASED_AT_LENGTH, readableReleasedAt, buildDayOf, noteReleasedAt };
