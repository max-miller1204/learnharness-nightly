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
import { feedNotesToGroups, groupsBetween, mergeNotesCache, readNotesCache, readUpdateRecord, whatsNew, writeUpdateRecord } from "../src/server/update-records.ts";
import { buildSummaryInput, countContributors, fallbackItems, formatSummary, parseHighlights, releaseStats, trimPullRequestBody, type PullRequest } from "../scripts/generate-release-notes.ts";

const require = createRequire(import.meta.url);
const electronNotes = require("../electron/release-notes.cjs") as {
	releaseNoteGroups(info: unknown): Array<{ version: string; releasedAt?: string; items: string[]; totalItems: number; intro?: string; stats?: string; footer?: string }>;
	summaryBody(note: unknown): string;
	FULL_CHANGELOG_MARKER: string;
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
		assert.equal(releaseNotes[0]!.totalItems, 10, "the whole count survives the cut (N more changes on GitHub)");
		assert.equal(capReleaseNoteGroups([{ version: V(1), items: [], intro: "3 bug fixes." }]).releaseNotes[0]!.totalItems, 1, "an intro counts as one");
	});

	it("the server keeps a feed note's summary fields", () => {
		assert.deepEqual(feedNotesToGroups([{ version: V(12), publishedAt: "2026-11-12T08:00:00Z", items: ["a"], stats: "4 changes from 2 contributors", footer: "Plus 1 more bug fix." }, { version: V(11), publishedAt: "", items: [], intro: "2 bug fixes." }]), [
			{ version: V(12), releasedAt: "2026-11-12T08:00:00Z", items: ["a"], stats: "4 changes from 2 contributors", footer: "Plus 1 more bug fix." },
			{ version: V(11), items: [], intro: "2 bug fixes." },
		]);
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

	it("formats highlights T3's way; the uncovered fixes are the footer, or the intro with no highlights", () => {
		assert.deepEqual(formatSummary(subjects, [{ label: "Flashcards.", detail: "Practice with cards.", commits: [1, 2] }]), {
			items: ["**Flashcards.** Practice with cards."],
			footer: "Plus 2 more bug fixes and performance improvements.",
		});
		assert.deepEqual(formatSummary(["fix: a"], []), { items: [], intro: "1 bug fix." });
		assert.deepEqual(formatSummary(["perf: a", "perf: b"], []), { items: [], intro: "2 performance improvements." });
		assert.deepEqual(formatSummary(["docs: a", "ci: b"], []), { items: [] }, "zero highlights and no fixes: nothing");
	});

	it("counts contributors T3's way and writes its stats line", () => {
		const commits = [
			{ subject: "feat: a (#1)", authorName: "Max Miller" },
			{ subject: "fix: b (#2)", authorName: "dependabot[bot]" },
			{ subject: "fix: c", authorName: "Max Miller" },
			{ subject: "docs: d", authorName: "Sam" },
		];
		const pullRequests = new Map<number, PullRequest>([
			[1, { body: "", author: { __typename: "User", login: "max-miller1204", name: "Max" } }],
			[2, { body: "", author: { __typename: "Bot", login: "dependabot" } }],
		]);
		assert.equal(countContributors(commits, pullRequests), 2, "a PR author once (their git name too), bots never, plus direct pushers");
		assert.equal(countContributors(commits, new Map()), 2, "without PR authors: the git names, bots aside");
		assert.equal(releaseStats(4, 2), "4 changes from 2 contributors");
		assert.equal(releaseStats(1, 1), "1 change from 1 contributor");
	});

	it("rejects a highlight that names a commit outside the input", () => {
		assert.equal(formatSummary(subjects, [{ label: "X", detail: "Y", commits: [9] }]), null);
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
		assert.equal(formatSummary(subjects, parsed), null, "a string number outside the input is still rejected");
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
		assert.deepEqual(groups, [{ version: V(12), releasedAt: "2026-11-12T00:00:00Z", items: ["**Flashcards.** Practice with cards.", "Plus 2 more bug fixes."], totalItems: 2 }]);
	});

	it("reads T3's generated body: the stats header, the items, the footer, or an intro paragraph", () => {
		const body = `**v${V(12)}** · 12 changes from 2 contributors\n\n- **Cards.** Practice with cards. (#5)\n- Faster graph\n\n### Plus 3 more bug fixes.\n\n<details>\n<summary>Full changelog</summary>\n\n- fix: x\n</details>`;
		assert.deepEqual(electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: body })[0], {
			version: V(12), items: ["**Cards.** Practice with cards.", "Faster graph"], totalItems: 2,
			stats: "12 changes from 2 contributors", footer: "Plus 3 more bug fixes.", releasedAt: "2026-11-12",
		});
		const fixesOnly = `**v${V(12)}** · 3 changes from 1 contributor\n\n**3 bug fixes.**\n\n<details>\n<summary>Full changelog</summary>\n</details>`;
		assert.deepEqual(electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: fixesOnly })[0], {
			version: V(12), items: [], totalItems: 1, intro: "3 bug fixes.", stats: "3 changes from 1 contributor", releasedAt: "2026-11-12",
		});
	});

	it("summaryBody writes the body the parser reads back (one format for the release page and the desktop)", () => {
		const note = { version: V(12), publishedAt: "", items: ["**Cards.** Practice with cards."], stats: "4 changes from 2 contributors", footer: "Plus 1 more bug fix." };
		const body = electronNotes.summaryBody(note);
		assert.equal(body, `**v${V(12)}** · 4 changes from 2 contributors\n\n- **Cards.** Practice with cards.\n\n### Plus 1 more bug fix.`);
		const [read] = electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: `${body}\n\n${electronNotes.FULL_CHANGELOG_MARKER}` });
		assert.deepEqual([read!.items, read!.stats, read!.footer], [note.items, note.stats, note.footer]);
		assert.equal(electronNotes.summaryBody({ version: V(12), items: [], intro: "2 bug fixes." }), "**2 bug fixes.**");
		assert.equal(electronNotes.summaryBody({ version: V(12), items: [] }), "", "nothing to say: no summary");
	});

	it("a plain list keeps its newest 8, newest first, with the whole count (GitHub lists oldest first)", () => {
		const note = Array.from({ length: 10 }, (_, i) => `- change ${i + 1}`).join("\n");
		const [read] = electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: note });
		assert.deepEqual(read!.items, ["change 10", "change 9", "change 8", "change 7", "change 6", "change 5", "change 4", "change 3"]);
		assert.equal(read!.totalItems, 10);
	});

	it("untagged notes named for another release are not this one's (T3's releaseNotesOfOfferedVersion)", () => {
		assert.deepEqual(electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: "- a", releaseName: `LearnHarness Nightly ${V(13)}` }), []);
		assert.equal(electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: "- a", releaseName: `LearnHarness Nightly ${V(12)} (abc)` }).length, 1);
	});

	it("keeps the feed's release date only when it is a bounded ISO date; the nightly's build day stands in otherwise", () => {
		const dated = (releaseDate: unknown) => electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: generated, releaseDate })[0]?.releasedAt;
		assert.equal(dated("2026-11-12T09:37:13.265Z"), "2026-11-12T09:37:13.265Z");
		assert.equal(dated("2026-11-12"), "2026-11-12");
		const buildDay = electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: generated })[0]?.releasedAt;
		for (const junk of ["yesterday", `2026-11-12T00:00:00Z${"x".repeat(5000)}`, "2026-13-45", 12]) assert.equal(dated(junk), buildDay, String(junk).slice(0, 30));
	});

	it("reads the per-version array (fullChangelog), stripping HTML", () => {
		const groups = electronNotes.releaseNoteGroups({
			version: V(12),
			releaseNotes: [
				{ version: V(12), note: "<ul><li><strong>New</strong> thing (#5)</li></ul>" },
				{ version: V(11), note: "" },
				{ version: V(10), note: "- older" },
			],
		});
		assert.deepEqual(groups.map((g) => g.version), [V(12), V(10)]);
		assert.deepEqual(groups[0]!.items, ["New thing (#5)"], "a plain list keeps no bold and its PR numbers, as T3's does");
		assert.equal(groups[1]!.releasedAt, "2026-11-10", "build day from the version");
		assert.equal(electronNotes.capGroups(groups).omittedReleaseCount, 0);
	});

	it("writes the same cache format the server reads", () => {
		electronNotes.mergeNotesCache(dir, [group(V(5)), group(V(6))]);
		assert.deepEqual(readNotesCache(dir).map((g) => g.version), [V(6), V(5)]);
	});
});
