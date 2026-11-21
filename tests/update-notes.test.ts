/**
 * Release notes and What's new (docs/specs/t3-style-updates.md): the data
 * folder records (src/server/update-records.ts), the release-time script's
 * pure parts (scripts/generate-release-notes.ts) and the Electron port of
 * T3's notes normalizer (electron/release-notes.cjs).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { capReleaseNoteGroups, MAX_RELEASE_NOTE_ITEM_LENGTH } from "../src/core/release-notes.ts";
import { groupsBetween, mergeNotesCache, readNotesCache, readUpdateRecord, whatsNew, writeUpdateRecord } from "../src/server/update-records.ts";
import { buildSummaryInput, fallbackItems, formatItems, parseHighlights, trimPullRequestBody } from "../scripts/generate-release-notes.ts";

const require = createRequire(import.meta.url);
const electronNotes = require("../electron/release-notes.cjs") as {
	releaseNoteGroups(info: unknown): Array<{ version: string; releasedAt?: string; items: string[] }>;
	capGroups(groups: unknown[]): { releaseNotes: unknown[]; omittedReleaseCount: number };
	mergeNotesCache(dir: string, groups: unknown[]): void;
};

const V = (day: number, run = 1) => `0.6.1-nightly.202611${String(day).padStart(2, "0")}.${run}`;
const group = (version: string, items = [`changed in ${version}`]) => ({ version, items });

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("notes limits", () => {
	it("caps at 6 groups, 8 items, 220 characters, counting the cut groups", () => {
		const groups = Array.from({ length: 9 }, (_, i) => group(V(20 - i), Array.from({ length: 10 }, (_, j) => (j === 0 ? "x".repeat(300) : `item ${j}`))));
		const { releaseNotes, omittedReleaseCount } = capReleaseNoteGroups(groups);
		assert.equal(releaseNotes.length, 6);
		assert.equal(omittedReleaseCount, 3);
		assert.equal(releaseNotes[0]!.items.length, 8);
		assert.equal(releaseNotes[0]!.items[0]!.length, MAX_RELEASE_NOTE_ITEM_LENGTH);
		assert.ok(releaseNotes[0]!.items[0]!.endsWith("..."));
	});

	it("selects the versions after one and up to another, newest first", () => {
		const groups = [group(V(10)), group(V(12)), group(V(11)), group(V(13))];
		assert.deepEqual(groupsBetween(groups, V(10), V(12)).releaseNotes.map((g) => g.version), [V(12), V(11)]);
		assert.deepEqual(groupsBetween(groups, undefined, V(11)).releaseNotes.map((g) => g.version), [V(11), V(10)]);
	});
});

describe("data folder records", () => {
	it("the notes cache merges (incoming wins), sorts and keeps the newest 30", () => {
		mergeNotesCache([group(V(1), ["old"]), group(V(2))], dir);
		mergeNotesCache([group(V(1), ["new"])], dir);
		const cached = readNotesCache(dir);
		assert.deepEqual(cached.map((g) => g.version), [V(2), V(1)]);
		assert.deepEqual(cached[1]!.items, ["new"]);
		mergeNotesCache(Array.from({ length: 40 }, (_, i) => group(V(3, i + 1))), dir);
		assert.equal(readNotesCache(dir).length, 30);
	});

	it("a corrupt cache or record reads as empty", () => {
		fs.writeFileSync(path.join(dir, "release-notes.json"), "{nope");
		fs.writeFileSync(path.join(dir, "updates.json"), "[]");
		assert.deepEqual(readNotesCache(dir), []);
		assert.deepEqual(readUpdateRecord(dir), {});
	});

	it("a fresh server records the running version and shows nothing", () => {
		assert.equal(whatsNew(V(12), dir), null);
		assert.equal(readUpdateRecord(dir).lastSeenVersion, V(12));
		assert.equal(whatsNew(V(12), dir), null, "same version: nothing");
	});

	it("after an update: everything since the last seen version; seen clears it", () => {
		writeUpdateRecord({ lastSeenVersion: V(10) }, dir);
		mergeNotesCache([group(V(9)), group(V(10)), group(V(11)), group(V(12)), group(V(13))], dir);
		const shown = whatsNew(V(12), dir);
		assert.equal(shown?.version, V(12));
		assert.deepEqual(shown?.releaseNotes.map((g) => g.version), [V(12), V(11)]);
		writeUpdateRecord({ lastSeenVersion: V(12) }, dir);
		assert.equal(whatsNew(V(12), dir), null);
	});

	it("an update with no cached notes still shows (the popup says Updated to X)", () => {
		writeUpdateRecord({ lastSeenVersion: V(10), dismissedNotice: "rolled-back:x:1" }, dir);
		assert.deepEqual(whatsNew(V(12), dir), { version: V(12), releaseNotes: [], omittedReleaseCount: 0 });
		assert.equal(readUpdateRecord(dir).dismissedNotice, "rolled-back:x:1", "patches keep other fields");
	});

	it("dev builds (not an exact version) never show it", () => {
		assert.equal(whatsNew("", dir), null);
		assert.equal(whatsNew("dev", dir), null);
		assert.deepEqual(readUpdateRecord(dir), {});
	});
});

describe("generate-release-notes", () => {
	const subjects = ["feat: add flashcards (#3)", "fix: crash on empty deck (#4)", "docs: readme", "perf: faster graph", "fix: typo"];

	it("formats highlights T3's way and counts the uncovered fixes", () => {
		const items = formatItems(subjects, [{ label: "Flashcards.", detail: "Practice with cards.", commits: [1, 2] }]);
		assert.deepEqual(items, ["**Flashcards.** Practice with cards.", "Plus 2 more bug fixes and performance improvements."]);
		assert.deepEqual(formatItems(["fix: a"], []), ["1 bug fix."]);
		assert.deepEqual(formatItems(["docs: a", "ci: b"], []), [], "zero highlights and no fixes: no items");
	});

	it("rejects a highlight that names a commit outside the input", () => {
		assert.equal(formatItems(subjects, [{ label: "X", detail: "Y", commits: [9] }]), null);
	});

	it("parses only the promised JSON", () => {
		assert.deepEqual(parseHighlights('```json\n{"highlights":[{"label":"A","detail":"B","commits":[1]}]}\n```'), [{ label: "A", detail: "B", commits: [1] }]);
		assert.equal(parseHighlights("not json"), null);
		assert.equal(parseHighlights('{"highlights":[{"label":"A","commits":[1]}]}'), null);
		assert.deepEqual(parseHighlights('{"highlights":[]}'), []);
	});

	it("reads commit numbers the model wrote as strings (real shapes from claude-haiku-5.5 runs)", () => {
		assert.deepEqual(parseHighlights('{"highlights":[{"label":"A","detail":"B","commits":["8"]}]}'), [{ label: "A", detail: "B", commits: [8] }]);
		assert.deepEqual(parseHighlights('{"highlights":[{"label":"A","detail":"B","commits":["[8]", 3]}]}'), [{ label: "A", detail: "B", commits: [8, 3] }]);
		assert.equal(parseHighlights('{"highlights":[{"label":"A","detail":"B","commits":["eight"]}]}'), null);
		assert.equal(parseHighlights('{"highlights":[{"label":"A","detail":"B","commits":[1.5]}]}'), null);
		const parsed = parseHighlights('{"highlights":[{"label":"A","detail":"B","commits":["[9]"]}]}')!;
		assert.equal(formatItems(subjects, parsed), null, "a string number outside the input is still rejected");
	});

	it("feeds numbered subjects and trimmed PR prose to the model", () => {
		const input = buildSummaryInput(["feat: x (#3)", "fix: y"], new Map([[3, "Adds x.\n\n![img](u)\n## Testing\nran it"]]));
		assert.equal(input, "[1] feat: x (#3)\n  > Adds x.\n[2] fix: y");
		assert.equal(trimPullRequestBody("a".repeat(400)).length, 303);
	});

	it("the fallback is the commit list, newest first, without PR numbers, first 8", () => {
		const many = Array.from({ length: 10 }, (_, i) => `feat: change ${i + 1} (#${i + 1})`);
		assert.deepEqual(fallbackItems(many).slice(0, 2), ["feat: change 10", "feat: change 9"]);
		assert.equal(fallbackItems(many).length, 8);
	});
});

describe("electron release notes (T3 port)", () => {
	const generated = "### What's changed\n\n- **Flashcards.** Practice with cards.\n- Plus 2 more bug fixes.\n\n<details>\n<summary>Full changelog</summary>\n\n- feat: x (abc)\n</details>\n\nNightly build of `abc`.";

	it("cuts a generated body at <details> and keeps the bold labels", () => {
		const groups = electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: generated, releaseDate: "2026-11-12T00:00:00Z" });
		assert.deepEqual(groups, [{ version: V(12), releasedAt: "2026-11-12T00:00:00Z", items: ["**Flashcards.** Practice with cards.", "Plus 2 more bug fixes."] }]);
	});

	it("keeps the feed's release date only when it is a bounded ISO date; the nightly's build day stands in otherwise", () => {
		const dated = (releaseDate: unknown) => electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: generated, releaseDate })[0]?.releasedAt;
		assert.equal(dated("2026-11-12T09:37:13.265Z"), "2026-11-12T09:37:13.265Z");
		assert.equal(dated("2026-11-12"), "2026-11-12");
		const buildDay = electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: generated })[0]?.releasedAt;
		for (const junk of ["yesterday", `2026-11-12T00:00:00Z${"x".repeat(5000)}`, "2026-13-45", 12]) assert.equal(dated(junk), buildDay, String(junk).slice(0, 30));
	});

	it("reads the per-version array (fullChangelog), stripping HTML and PR numbers", () => {
		const groups = electronNotes.releaseNoteGroups({
			version: V(12),
			releaseNotes: [
				{ version: V(12), note: "<ul><li><strong>New</strong> thing (#5)</li></ul>" },
				{ version: V(11), note: "" },
				{ version: V(10), note: "- older" },
			],
		});
		assert.deepEqual(groups.map((g) => g.version), [V(12), V(10)]);
		assert.deepEqual(groups[0]!.items, ["**New** thing"]);
		assert.equal(groups[1]!.releasedAt, "2026-11-10", "build day from the version");
		assert.equal(electronNotes.capGroups(groups).omittedReleaseCount, 0);
	});

	it("writes the same cache format the server reads", () => {
		electronNotes.mergeNotesCache(dir, [group(V(5)), group(V(6))]);
		assert.deepEqual(readNotesCache(dir).map((g) => g.version), [V(6), V(5)]);
	});
});
