/**
 * One table of release-date inputs for every path that dates a note: the server's feed read
 * (tests/self-update.test.ts) and the desktop's provider (tests/nightly-updater.test.ts). Each
 * case names the time a feed note carries (`own`, "" for none), the pointer's time (`pointer`)
 * and the date the offered note and an older note must show, the same on both.
 */
export const OFFERED = "0.6.1-nightly.20261118.3";
export const OLDER = "0.6.1-nightly.20261118.2";
const BUILD_DAY = "2026-11-18";

export interface DateCase {
	name: string;
	own: string;
	pointer: string;
	offered: string;
	older: string;
}

const POINTER = "2026-11-12T00:00:00Z";

export const DATE_CASES: readonly DateCase[] = [
	{ name: "the note's own time", own: "2026-11-14T08:00:00Z", pointer: POINTER, offered: "2026-11-14T08:00:00Z", older: "2026-11-14T08:00:00Z" },
	{ name: "a time zone offset", own: "2026-11-14T08:00:00+02:00", pointer: POINTER, offered: "2026-11-14T08:00:00+02:00", older: "2026-11-14T08:00:00+02:00" },
	{ name: "a date only", own: "2026-11-14", pointer: POINTER, offered: "2026-11-14", older: "2026-11-14" },
	{ name: "a time in the future", own: "2027-01-01T00:00:00Z", pointer: POINTER, offered: "2027-01-01T00:00:00Z", older: "2027-01-01T00:00:00Z" },
	{ name: "no time on the note", own: "", pointer: POINTER, offered: POINTER, older: BUILD_DAY },
	{ name: "an unparseable time", own: "last week", pointer: POINTER, offered: POINTER, older: BUILD_DAY },
	{ name: "a time with no zone", own: "2026-11-14T08:00:00", pointer: POINTER, offered: POINTER, older: BUILD_DAY },
	{ name: "a month that does not exist", own: "2026-13-45", pointer: POINTER, offered: POINTER, older: BUILD_DAY },
	{ name: "a time past the length bound", own: `2026-11-14T08:00:00Z${"0".repeat(40)}`, pointer: POINTER, offered: POINTER, older: BUILD_DAY },
	{ name: "the pointer's time is a date only", own: "", pointer: "2026-11-13", offered: "2026-11-13", older: BUILD_DAY },
	{ name: "no readable pointer time", own: "last week", pointer: "yesterday", offered: BUILD_DAY, older: BUILD_DAY },
	{ name: "no pointer time at all", own: "", pointer: "", offered: BUILD_DAY, older: BUILD_DAY },
	{ name: "the note's time over a readable pointer", own: "2026-11-15", pointer: "2026-11-16", offered: "2026-11-15", older: "2026-11-15" },
];

/** How a feed note carries its time: a value, or for a case with none, the key left out or sent as "". */
export const noteTimeShapes = (c: DateCase): readonly ("value" | "missing" | "empty")[] => (c.own ? ["value"] : ["missing", "empty"]);
