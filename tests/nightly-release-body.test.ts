/**
 * The nightly release body (docs/specs/t3-style-updates.md, revision PR 2):
 * runs the real "Release notes" step of .github/workflows/nightly.yml with
 * bash, in a scratch folder with a notes.json, and reads the notes.md it
 * writes the way the desktop reads a GitHub release body
 * (electron/release-notes.cjs, the T3 parser).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const require = createRequire(import.meta.url);
const { releaseNoteGroups } = require("../electron/release-notes.cjs") as {
	releaseNoteGroups(info: unknown): Array<{ version: string; items: string[]; stats?: string; intro?: string; footer?: string }>;
};

const REPO = path.resolve(import.meta.dirname, "..");
const VERSION = "0.6.1-nightly.20261120.5";

/** The step's `run: |` block, dedented, exactly as the workflow has it. */
function releaseNotesStep(): string {
	const lines = fs.readFileSync(path.join(REPO, ".github/workflows/nightly.yml"), "utf8").split("\n");
	const step = lines.findIndex((line) => /^\s*- name: Release notes\s*$/.test(line));
	assert.ok(step >= 0, "the Release notes step");
	const run = lines.findIndex((line, index) => index > step && /^\s*run: \|\s*$/.test(line));
	const indent = (lines[run + 1]!.match(/^\s*/)?.[0] ?? "").length;
	const body: string[] = [];
	for (const line of lines.slice(run + 1)) {
		if (line.trim() === "") { body.push(""); continue; }
		if ((line.match(/^\s*/)?.[0] ?? "").length < indent) break;
		body.push(line.slice(indent));
	}
	return body.join("\n");
}

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-release-body-"));
	fs.symlinkSync(path.join(REPO, "electron"), path.join(dir, "electron"));
	// A stand-in git for the folded list: the step's only other command.
	fs.mkdirSync(path.join(dir, "bin"));
	fs.writeFileSync(path.join(dir, "bin", "git"), "#!/bin/sh\necho '- fix: a crash (abc1234)'\n", { mode: 0o755 });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function runStep(notes: unknown, prev: string): string {
	fs.writeFileSync(path.join(dir, "notes.json"), JSON.stringify(notes));
	const result = spawnSync("bash", ["-e", "-c", releaseNotesStep()], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, PREV: prev, SHA: "abcdef1234567890", FORK_HOMEPAGE: "https://github.com/o/r", GITHUB_STEP_SUMMARY: path.join(dir, "summary.md") },
	});
	assert.equal(result.status, 0, result.stderr);
	return fs.readFileSync(path.join(dir, "notes.md"), "utf8");
}

const generated = { version: VERSION, publishedAt: "t", items: ["**Cards.** Practice with cards.", "Plus 2 more bug fixes."], stats: "4 changes from 2 contributors", footer: "Plus 2 more bug fixes." };

test("a first nightly's body (no earlier tag) still reads as T3's generated summary", () => {
	const body = runStep(generated, "");
	assert.ok(body.startsWith(`**v${VERSION}** · 4 changes from 2 contributors\n`), "the summary leads");
	assert.ok(body.includes("<summary>Full changelog</summary>"), "the folded list follows, even with nothing to compare");
	const [group] = releaseNoteGroups({ version: VERSION, releaseNotes: body });
	assert.deepEqual([group!.items, group!.stats, group!.footer], [["**Cards.** Practice with cards."], "4 changes from 2 contributors", "Plus 2 more bug fixes."]);
});

test("a later nightly folds the commit list under the summary", () => {
	const body = runStep(generated, "v0.6.1-nightly.20261119.1");
	assert.ok(body.includes("### Changes since v0.6.1-nightly.20261119.1\n- fix: a crash (abc1234)"));
	const [group] = releaseNoteGroups({ version: VERSION, releaseNotes: body });
	assert.deepEqual([group!.items, group!.stats, group!.footer], [["**Cards.** Practice with cards."], "4 changes from 2 contributors", "Plus 2 more bug fixes."]);
	assert.ok(!body.includes("- Plus 2 more"), "the old-client copy of the footer stays out of the page");
});

test("highlights that look like HTML or links come back exactly from the real release body", () => {
	const tricky = ["**HTML.** Keep <br> in exports.", "**Links.** Use [a link](https://x.test) & <b>tags</b> as text.", "**Entities.** Write &amp; and &lt; literally."];
	const body = runStep({ ...generated, items: [...tricky, generated.footer] }, "v0.6.1-nightly.20261119.1");
	const [group] = releaseNoteGroups({ version: VERSION, releaseNotes: body });
	assert.deepEqual(group!.items, tricky, "three highlights, none split off as an intro");
	assert.equal(group!.intro, undefined);
	assert.equal(group!.footer, "Plus 2 more bug fixes.");
});

test("with nothing to say the body starts with the folded list", () => {
	const body = runStep({ version: VERSION, publishedAt: "t", items: [] }, "");
	assert.ok(body.startsWith("<details>"));
});
