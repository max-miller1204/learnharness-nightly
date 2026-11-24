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
import { capReleaseNoteGroups, type ReleaseNoteGroup, MAX_RELEASE_NOTE_ITEM_LENGTH, totalReleaseItems, withoutSummaryEcho } from "../src/core/release-notes.ts";
import { releaseLinkLabel } from "../components/release-notes-view.tsx";
import { readDesktopAppStatus } from "../components/settings/update-settings.tsx";
import { feedNotesToGroups, groupsBetween, mergeNotesCache, readNotesCache, readUpdateRecord, whatsNew, writeUpdateRecord } from "../src/server/update-records.ts";
import { buildSummaryInput, countContributors, entryItems, fallbackItems, formatSummary, parseHighlights, pullRequestFor, readPullRequests, releaseStats, trimPullRequestBody, type PullRequest } from "../scripts/generate-release-notes.ts";

const require = createRequire(import.meta.url);
const electronNotes = require("../electron/release-notes.cjs") as {
	releaseNoteGroups(info: unknown): Array<{ version: string; releasedAt?: string; items: string[]; totalItems: number; intro?: string; stats?: string; footer?: string }>;
	summaryBody(note: unknown): string;
	FULL_CHANGELOG_MARKER: string;
	capGroups(groups: unknown[]): { releaseNotes: Array<{ version: string; items: string[]; totalItems: number; intro?: string; stats?: string; footer?: string }>; omittedReleaseCount: number };
	bridgeNotes(groups: unknown[], omitted: number): { releaseNotes: Array<{ version: string; releasedAt?: string; items: string[]; totalItems: number; intro?: string; footer?: string }>; omittedReleaseCount: number };
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

	it("older clients still see the intro or footer (written once more as the last item); every stored or sent copy keeps it", () => {
		const withFooter = { items: ["**Cards.** Practice."], footer: "Plus 2 more bug fixes." };
		const introOnly = { items: [], intro: "3 bug fixes." };
		assert.deepEqual(entryItems(withFooter), ["**Cards.** Practice.", "Plus 2 more bug fixes."], "an older server or app shows the count as a bullet");
		assert.deepEqual(entryItems(introOnly), ["3 bug fixes."], "and an intro-only release isn't empty there");
		assert.deepEqual(entryItems({ items: ["a"] }), ["a"]);
		// The server's state and cache keep it (its own older pages read only items); the count leaves it out.
		const groups = feedNotesToGroups([
			{ version: V(12), publishedAt: "", items: entryItems(withFooter), footer: withFooter.footer },
			{ version: V(11), publishedAt: "", items: entryItems(introOnly), intro: introOnly.intro },
		]);
		assert.deepEqual(groups.map((g) => g.items), [["**Cards.** Practice.", "Plus 2 more bug fixes."], ["3 bug fixes."]]);
		assert.deepEqual(groups.map(totalReleaseItems), [1, 1]);
		// So does the desktop: main's state, the cache and the bridge.
		const desktop = electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: [
			{ version: V(12), items: entryItems(withFooter), footer: withFooter.footer },
			{ version: V(11), items: entryItems(introOnly), intro: introOnly.intro },
		] });
		assert.deepEqual(desktop.map((g) => [g.items, g.totalItems]), [[["**Cards.** Practice.", "Plus 2 more bug fixes."], 1], [["3 bug fixes."], 1]]);
		// A page from before the summary fields (the old readDesktopAppStatus kept version, releasedAt and items)
		// still shows "Plus 2 more" and "3 bug fixes." from what the bridge sends.
		const sent = electronNotes.bridgeNotes(desktop, 0).releaseNotes;
		const oldReader = sent.map((group) => ({ version: group.version, ...(group.releasedAt ? { releasedAt: group.releasedAt } : {}), items: group.items }));
		assert.deepEqual(oldReader.map((g) => g.items), [["**Cards.** Practice.", "Plus 2 more bug fixes."], ["3 bug fixes."]]);
		// The release page shows it once.
		assert.equal(electronNotes.summaryBody({ version: V(12), items: entryItems(introOnly), intro: introOnly.intro }), "**3 bug fixes.**");
		assert.ok(!electronNotes.summaryBody({ version: V(12), items: entryItems(withFooter), footer: withFooter.footer }).includes("- Plus 2"));
	});

	it("only the single trailing copy is the old-client echo: a bullet with the same text elsewhere stays", () => {
		const footer = "Plus 2 more bug fixes.";
		assert.deepEqual(withoutSummaryEcho([footer, "New feature.", footer], { footer }), [footer, "New feature."]);
		assert.deepEqual(withoutSummaryEcho([footer, "New feature."], { footer }), [footer, "New feature."], "not the last item: no echo");
		assert.deepEqual(withoutSummaryEcho(["a", `  Plus 2   more bug fixes. `], { footer }), ["a"], "compared normalized");
		assert.deepEqual(withoutSummaryEcho(["a"], {}), ["a"]);
		// Through main and then the bridge (two bounding passes, the second over cut items), a long bullet
		// whose cut form reads like the footer is neither dropped nor uncounted.
		const longFooter = `${"x".repeat(217)}...`;
		const kept = electronNotes.capGroups([{ version: V(12), items: ["a", "x".repeat(300)], footer: longFooter }]).releaseNotes;
		const [group] = electronNotes.bridgeNotes(kept, 0).releaseNotes;
		assert.equal(group!.items.length, 2, "the long bullet is still sent");
		assert.equal(group!.totalItems, 2, "and still counts");
	});

	it("a footer alone is a release to show (no stats, only the footer and its copy; or a body with stats and a ### line)", () => {
		const [fromFeed] = electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: [{ version: V(12), items: ["Thanks to everyone who tested."], footer: "Thanks to everyone who tested." }] });
		assert.deepEqual([fromFeed?.footer, fromFeed?.totalItems], ["Thanks to everyone who tested.", 0]);
		const body = `**v${V(12)}** · 1 change from 1 contributor\n\n### Thanks to everyone who tested.\n\n${electronNotes.FULL_CHANGELOG_MARKER}`;
		const [fromPage] = electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: body });
		assert.deepEqual([fromPage?.stats, fromPage?.footer], ["1 change from 1 contributor", "Thanks to everyone who tested."]);
	});

	it("the same note reads the same date on the server and the desktop: the feed's time, else the build day", () => {
		const notes = [
			{ version: V(18), publishedAt: "2026-11-14T08:00:00Z", items: ["dated by the feed"] },
			{ version: V(17), publishedAt: "", items: ["no feed time"] },
			{ version: V(16), publishedAt: "last week", items: ["an unreadable one"] },
		];
		const server = feedNotesToGroups(notes).map((g) => [g.version, g.releasedAt]);
		// The desktop's NightlyProvider hands each note over with its publish time as releasedAt.
		const desktop = electronNotes.releaseNoteGroups({ version: V(18), releaseNotes: notes.map((n) => ({ version: n.version, items: n.items, ...(n.publishedAt ? { releasedAt: n.publishedAt } : {}) })) }).map((g) => [g.version, g.releasedAt]);
		assert.deepEqual(server, [[V(18), "2026-11-14T08:00:00Z"], [V(17), "2026-11-17"], [V(16), "2026-11-16"]]);
		assert.deepEqual(desktop, server);
	});

	it("the copy is told apart from a real item where the whole list is known, and the decision survives the cut, the bridge and the cache", () => {
		const footer = "Plus 2 more bug fixes.";
		const real = (n: number, eighth?: string) => Array.from({ length: n }, (_, i) => (i === 7 && eighth ? eighth : `**Feature ${i + 1}.** Detail ${i + 1}.`));
		const shown = (group: ReleaseNoteGroup) =>
			[withoutSummaryEcho(group.items, group), releaseLinkLabel(group)] as const;
		const cases: Array<{ name: string; items: string[]; footer: string; shown: string[]; label: string }> = [
			{ name: "9 real highlights, the 8th reading like the footer, then the copy", items: [...real(9, footer), footer], footer, shown: real(8, footer), label: "1 more change on GitHub" },
			{ name: "9 real highlights then the copy", items: [...real(9), "Plus 1 more bug fix."], footer: "Plus 1 more bug fix.", shown: real(8), label: "1 more change on GitHub" },
			{ name: "8 real highlights, the 8th reading like the footer, then the copy", items: [...real(8, footer), footer], footer, shown: real(8, footer), label: "View release on GitHub" },
			{ name: "7 highlights then the copy", items: [...real(7), footer], footer, shown: real(7), label: "View release on GitHub" },
		];
		for (const c of cases) {
			const note = { version: V(12), publishedAt: "", items: c.items, footer: c.footer };
			// The server: the feed read, the cut, then the cache written and read back.
			const [server] = groupsBetween(feedNotesToGroups([note]), undefined, V(12)).releaseNotes;
			mergeNotesCache([server!], dir);
			const [reloaded] = readNotesCache(dir);
			// The desktop: the note reader, main's cap, the bridge, then its cache file read by the server.
			const [desktopFull] = electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: [{ version: V(12), items: c.items, footer: c.footer }] });
			const [capped] = electronNotes.capGroups([desktopFull]).releaseNotes;
			const [bridged] = electronNotes.bridgeNotes([capped], 0).releaseNotes;
			const [rebounded] = electronNotes.bridgeNotes([bridged], 0).releaseNotes;
			// The page's own tolerant read of the bridge's status keeps the decision too.
			const [onPage] = readDesktopAppStatus({ version: "0.6.1", phase: "idle", releaseNotes: [bridged], omittedReleaseCount: 0 })!.releaseNotes ?? [];
			electronNotes.mergeNotesCache(dir, [capped]);
			const [fromDesktopCache] = readNotesCache(dir);
			for (const [where, group] of [["server", server!], ["server cache", reloaded!], ["desktop", capped!], ["bridge", bridged!], ["bridge again", rebounded!], ["page", onPage!], ["desktop cache", fromDesktopCache!]] as const) {
				assert.deepEqual(shown(group), [c.shown, c.label], `${c.name}: ${where}`);
			}
			fs.rmSync(path.join(dir, "release-notes.json"), { force: true });
		}
	});

	it("a generated release body lists real items only: its full list ending like the footer keeps the last one", () => {
		const footer = "Plus 2 more bug fixes.";
		const items = Array.from({ length: 9 }, (_, i) => (i === 7 ? footer : `**Feature ${i + 1}.** Detail ${i + 1}.`));
		const body = `${electronNotes.summaryBody({ version: V(12), stats: "11 changes from 2 contributors", items, footer })}\n\n${electronNotes.FULL_CHANGELOG_MARKER}`;
		const [group] = electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: body });
		const [bridged] = electronNotes.bridgeNotes(electronNotes.capGroups([group!]).releaseNotes, 0).releaseNotes;
		assert.equal(bridged!.items.length, 8);
		assert.deepEqual(withoutSummaryEcho(bridged!.items, bridged!), bridged!.items.map((item) => item), "all 8 shown, the 8th reading like the footer included");
		assert.equal(bridged!.totalItems, 9);
	});

	it("a group stored before the decision was recorded reads as it did: a last item reading like the footer is the copy unless the count says nothing was cut", () => {
		const footer = "Plus 2 more bug fixes.";
		const seven = Array.from({ length: 7 }, (_, i) => `**Feature ${i + 1}.** Detail ${i + 1}.`);
		fs.writeFileSync(path.join(dir, "release-notes.json"), JSON.stringify({ groups: [
			{ version: V(12), items: [...seven, footer], totalItems: 9, footer },
			{ version: V(11), items: [...seven, footer], totalItems: 7, footer },
			{ version: V(10), items: [...seven, footer], footer },
		] }));
		const [counted, whole, uncounted] = readNotesCache(dir);
		assert.equal(counted!.summaryCopy, undefined, "nothing is invented for a stored group");
		assert.deepEqual(withoutSummaryEcho(counted!.items, counted!), seven);
		assert.equal(releaseLinkLabel(counted!), "2 more changes on GitHub");
		assert.deepEqual(withoutSummaryEcho(whole!.items, whole!), seven);
		assert.deepEqual(withoutSummaryEcho(uncounted!.items, uncounted!), seven);
		const eight = [...seven, footer];
		assert.deepEqual(withoutSummaryEcho(eight, { footer, totalItems: 8 }), eight, "a full stored list that no count says was cut keeps its last item");
		assert.deepEqual(withoutSummaryEcho(eight, { footer, totalItems: 8, summaryCopy: true }), seven, "a recorded copy goes whatever the count says");
		assert.deepEqual(withoutSummaryEcho(eight, { footer, totalItems: 9, summaryCopy: false }), eight, "a recorded real item stays whatever the count says");
	});

	it("a full list whose last item reads like the footer: the copy only when the whole count says items were cut", () => {
		const footer = "Plus 2 more bug fixes.";
		const seven = Array.from({ length: 7 }, (_, i) => `**Feature ${i + 1}.** Detail ${i + 1}.`);
		const shape = (items: string[], totalItems: number) => ({ version: V(12), items, totalItems, footer });
		// What the release script writes (at most 7 highlights, then the copy), as it is stored whole or cut.
		const whole = shape([...seven, footer], 7);
		assert.deepEqual(withoutSummaryEcho(whole.items, whole), seven, "7 highlights and the copy: the copy goes");
		assert.equal(releaseLinkLabel(whole), "View release on GitHub");
		// A count above the list (items the feed counted but did not send): the last item is still the copy.
		const counted = shape([...seven, footer], 9);
		assert.deepEqual(withoutSummaryEcho(counted.items, counted), seven, "7 and the copy with a count of 9: the copy goes, as it always did");
		assert.equal(releaseLinkLabel(counted), "2 more changes on GitHub");
		// A full list with no item missing: the count equals its length, so the last item is a real highlight.
		const eight = shape([...seven, footer], 8);
		assert.deepEqual(withoutSummaryEcho(eight.items, eight), eight.items, "8 real items and a count of 8: all shown");
		assert.equal(releaseLinkLabel(eight), "View release on GitHub");
		// A list shorter than the cap has no cut, whatever the count says.
		const short = shape([...seven.slice(0, 3), footer], 3);
		assert.deepEqual(withoutSummaryEcho(short.items, short), seven.slice(0, 3));
		assert.deepEqual(withoutSummaryEcho([...seven, footer], { footer }), seven, "no count: the last item is the copy");
		// An intro stands for one of the counted items.
		assert.deepEqual(withoutSummaryEcho(Array.from({ length: 8 }, (_, i) => (i === 7 ? "3 bug fixes." : `item ${i}`)), { intro: "3 bug fixes.", totalItems: 9 }).length, 8, "7 items and the intro make 8 real: nothing was cut");
	});

	it("one limit set everywhere: the server's groups and cache match the desktop's, 8 items of 220 characters, counted whole", () => {
		const long = "y".repeat(600);
		const note = { version: V(12), publishedAt: "", items: [...Array.from({ length: 8 }, (_, i) => `item ${i}`), long], intro: undefined };
		const [server] = feedNotesToGroups([note]);
		const [desktop] = electronNotes.capGroups([{ version: V(12), items: note.items }]).releaseNotes;
		assert.equal(server!.items.length, 8);
		assert.deepEqual([server!.items, server!.totalItems], [desktop!.items, desktop!.totalItems]);
		assert.equal(server!.totalItems, 9, "the cut ninth still counts");
		// An intro at its 600-character bound, with its copy cut to 220: still the copy, on both.
		const introNote = { version: V(11), publishedAt: "", items: [long], intro: long };
		const [serverIntro] = feedNotesToGroups([introNote]);
		const [desktopIntro] = electronNotes.capGroups([{ version: V(11), items: [long], intro: long }]).releaseNotes;
		assert.equal(serverIntro!.items[0]!.length, 220);
		assert.deepEqual([serverIntro!.items, serverIntro!.totalItems], [desktopIntro!.items, desktopIntro!.totalItems]);
		assert.deepEqual(withoutSummaryEcho(serverIntro!.items, serverIntro!), [], "its cut copy is recognised");
		assert.equal(totalReleaseItems(serverIntro!), 1, "the intro counts once, as T3 counts it");
		mergeNotesCache([serverIntro!], dir);
		assert.deepEqual(readNotesCache(dir)[0]!.items, serverIntro!.items, "the server's cache holds the same");
	});

	it("summary fields are trimmed and collapsed before their bounds", () => {
		const padded = `  ${"x".repeat(60)}   ${"y".repeat(58)}  `;
		const [group] = feedNotesToGroups([{ version: V(12), publishedAt: "", items: [], stats: padded }]);
		assert.equal(group!.stats, `${"x".repeat(60)} ${"y".repeat(58)}`, "119 characters once collapsed: kept");
	});

	it("the server keeps a feed note's summary fields", () => {
		assert.deepEqual(feedNotesToGroups([{ version: V(12), publishedAt: "2026-11-12T08:00:00Z", items: ["a"], stats: "4 changes from 2 contributors", footer: "Plus 1 more bug fix." }, { version: V(11), publishedAt: "", items: [], intro: "2 bug fixes." }]), [
			{ version: V(12), releasedAt: "2026-11-12T08:00:00Z", items: ["a"], totalItems: 1, stats: "4 changes from 2 contributors", footer: "Plus 1 more bug fix." },
			{ version: V(11), releasedAt: "2026-11-11", items: [], totalItems: 1, intro: "2 bug fixes." },
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
			{ subject: "feat: a (#1)", authorName: "Max Miller", sha: "aaa1" },
			{ subject: "fix: b (#2)", authorName: "dependabot[bot]", sha: "bbb2" },
			{ subject: "fix: c", authorName: "Max Miller", sha: "ccc3" },
			{ subject: "docs: d", authorName: "Sam", sha: "ddd4" },
		];
		const pullRequests = new Map<number, PullRequest>([
			[1, { body: "", author: { __typename: "User", login: "max-miller1204", name: "Max" }, mergeCommit: "aaa1" }],
			[2, { body: "", author: { __typename: "Bot", login: "dependabot" }, mergeCommit: "bbb2" }],
		]);
		assert.equal(countContributors(commits, pullRequests), 2, "a PR author once (their git name too), bots never, plus direct pushers");
		assert.equal(countContributors(commits, new Map()), 2, "without PR authors: the git names, bots aside");
		assert.equal(releaseStats(4, 2), "4 changes from 2 contributors");
		assert.equal(releaseStats(1, 1), "1 change from 1 contributor");
	});

	it("reads the PRs a partly failing GraphQL query still returned (gh exits non-zero on a missing PR)", () => {
		const partial = JSON.stringify({ data: { repository: { pr1: { body: "Adds x.", author: { __typename: "User", login: "max", name: "Max" } }, pr9: null } }, errors: [{ message: "Could not resolve to a PullRequest with the number of 9." }] });
		const gh = () => { throw Object.assign(new Error("gh: exit 1"), { stdout: partial }); };
		const read = readPullRequests("o/r", [1, 9], gh);
		assert.deepEqual([...read.keys()], [1]);
		assert.equal(read.get(1)!.author!.login, "max");
		assert.equal(readPullRequests("o/r", [1], () => { throw new Error("no gh"); }).size, 0, "no output at all: no PRs, no throw");
	});

	it("an imported upstream commit's (#N) is not this repo's PR #N: no author, no body from it", () => {
		const ours: PullRequest = { body: "Our own PR 190.", author: { __typename: "User", login: "max-miller1204", name: "Max Miller" }, mergeCommit: "f0f0" };
		const pullRequests = new Map<number, PullRequest>([[190, ours]]);
		const imported = { subject: "feat: upstream thing (#190)", authorName: "Upstream Dev", sha: "u1u1" };
		const own = { subject: "feat: our thing (#190)", authorName: "Max Miller", sha: "f0f0" };
		assert.equal(pullRequestFor(imported, pullRequests), undefined, "another sha and another author");
		assert.equal(pullRequestFor(own, pullRequests), ours, "the commit the PR merged");
		assert.equal(pullRequestFor({ ...own, sha: "rebased" }, pullRequests), ours, "or the same author (a rebased copy)");
		assert.equal(countContributors([imported], pullRequests), 1, "the upstream author counts by git name");
		assert.equal(countContributors([imported, own], pullRequests), 2, "each commit gets its own answer");
		const input = buildSummaryInput([imported.subject, own.subject], new Map([[190, ours.body]]), (index) => pullRequestFor([imported, own][index]!, pullRequests) !== undefined);
		assert.equal(input, "[1] feat: upstream thing (#190)\n[2] feat: our thing (#190)\n  > Our own PR 190.", "the body only for the commit it belongs to");
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

	it("any footer survives the release page's round trip, not only T3's Plus N more", () => {
		const note = { version: V(12), items: ["a"], footer: "Thanks to everyone who tested." };
		const [read] = electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: `${electronNotes.summaryBody(note)}\n\n${electronNotes.FULL_CHANGELOG_MARKER}` });
		assert.deepEqual([read!.items, read!.footer], [["a"], "Thanks to everyone who tested."]);
		const headed = `### What's changed\n\n- a\n\n${electronNotes.FULL_CHANGELOG_MARKER}`;
		assert.equal(electronNotes.releaseNoteGroups({ version: V(12), releaseNotes: headed })[0]!.footer, undefined, "a heading before the items is still skipped");
	});

	it("main's own copy (the local window, via capGroups) and the notes cache hold the bridge's bounds", () => {
		const long = "x".repeat(601);
		const groups = [
			{ version: V(12), items: Array.from({ length: 12 }, (_, i) => `item ${i}`), intro: long, stats: "s".repeat(121), footer: "f".repeat(221), extra: long },
			{ version: "not a version", items: ["x"] },
		];
		const { releaseNotes, omittedReleaseCount } = electronNotes.capGroups(groups);
		assert.equal(releaseNotes.length, 1, "an invalid version is dropped");
		assert.deepEqual(Object.keys(releaseNotes[0]!), ["version", "items", "totalItems"], "no unbounded intro, stats or footer, no extra fields");
		assert.equal(releaseNotes[0]!.items.length, 8);
		assert.equal(releaseNotes[0]!.totalItems, 12, "the whole count survives the cut");
		assert.equal(omittedReleaseCount, 0);
		electronNotes.mergeNotesCache(dir, groups);
		const cached = JSON.parse(fs.readFileSync(path.join(dir, "release-notes.json"), "utf8")).groups;
		assert.equal(cached.length, 1);
		assert.equal(cached[0].intro, undefined, "the cache holds the bounds too");
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
