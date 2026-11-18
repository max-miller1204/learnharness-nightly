// Ported from T3 Code, apps/server/src/workspace/IgnorePatterns.test.ts (commit 4ecbe550, MIT; see
// lib/ignore-patterns.LICENSE), as node:test, plus LearnHarness's folder-level gitignore filter.
import assert from "node:assert/strict";
import { it } from "node:test";
import { createGitignoreFilter, parseIgnoreFile } from "../lib/ignore-patterns.ts";

const decide = (contents: string, path: string, isFolder = false) => parseIgnoreFile(contents).decide(path, isFolder);

it("lets the last matching pattern decide, including negations", () => {
	assert.equal(decide("*keep*\n!*keep*\n", "sub/keep-link.ts"), "included");
	assert.equal(decide("!*keep*\n*keep*\n", "sub/keep-link.ts"), "ignored");
	assert.equal(decide("# comment\n\nother\n", "keep.ts"), undefined);
});

it("anchors patterns that contain a slash and matches bare names at any depth", () => {
	assert.equal(decide("link", "a/b/link"), "ignored");
	assert.equal(decide("/link", "a/link"), undefined);
	assert.equal(decide("/link", "link"), "ignored");
	assert.equal(decide("a/link", "x/a/link"), undefined);
	assert.equal(decide("a/*.ts", "a/b/c.ts"), undefined);
	assert.equal(decide("link", "blink"), undefined);
	assert.equal(decide("link", "a/blink"), undefined);
});

it("supports globstars, classes, escapes, and folder-only patterns", () => {
	assert.equal(decide("**/gen/*.ts", "gen/a.ts"), "ignored");
	assert.equal(decide("a/**/b", "a/x/y/b"), "ignored");
	assert.equal(decide("a/**/b", "a/b"), "ignored");
	assert.equal(decide("foo/**/bar", "foo/xbar"), undefined);
	assert.equal(decide("foo/**/bar", "foo/x/ybar"), undefined);
	assert.equal(decide("out/**", "out/x/y"), "ignored");
	assert.equal(decide("link-[0-9]", "link-7"), "ignored");
	assert.equal(decide("link-[!0-9]", "link-7"), undefined);
	assert.equal(decide("link-?", "link-/"), undefined);
	assert.equal(decide("link-?", "link-ø"), undefined);
	assert.equal(decide("link-??", "link-ø"), "ignored");
	assert.equal(decide("link-ø", "link-ø"), "ignored");
	assert.equal(decide("\\!bang\n\\#hash\nstar\\*", "!bang"), "ignored");
	assert.equal(decide("\\!bang\n\\#hash\nstar\\*", "#hash"), "ignored");
	assert.equal(decide("\\!bang\n\\#hash\nstar\\*", "starx"), undefined);
	assert.equal(decide("dist/", "dist"), undefined);
	assert.equal(decide("dist/", "dist", true), "ignored");
});

it("matches adversarial patterns in linear time", () => {
	// A backtracking regex takes seconds to reject this pair; the vitest timeout catches that.
	const pattern = `${"a*".repeat(20)}b\n`;
	assert.equal(decide(pattern, `${"a".repeat(200)}c`), undefined);
	assert.equal(decide(pattern.repeat(50), `${"a".repeat(1_000)}c`), undefined);
	assert.equal(decide(pattern, `${"a".repeat(200)}b`), "ignored");
});

it("parses unclosed classes in linear time", () => {
	// Rescanning the rest of the line for each `[` stalls for over a minute here; linear takes ms.
	assert.equal(decide("[".repeat(30_000), "[".repeat(30_000)), "ignored");
	assert.equal(decide(`${"[".repeat(30_000)}]`, "x"), undefined);
	assert.equal(decide("[a][", "a["), "ignored");
});

it("createGitignoreFilter: nested files decide relative to their folder, deeper rules win, ignored folders hide everything below", () => {
	const ignored = createGitignoreFilter(new Map([
		["app", parseIgnoreFile("node_modules\n*.log\nbuild/\n")],
		["app/scripts", parseIgnoreFile("*.tmp\n!keep.tmp\n!debug.log\n")],
	]));
	assert.equal(ignored("app/index.js"), false);
	assert.equal(ignored("app/node_modules/pkg/index.js"), true);
	assert.equal(ignored("app/server.log"), true);
	assert.equal(ignored("app/scripts/debug.log"), false, "the deeper negation wins");
	assert.equal(ignored("app/scripts/x.tmp"), true);
	assert.equal(ignored("app/scripts/keep.tmp"), false);
	assert.equal(ignored("app/build/out.js"), true, "a folder-only pattern hides the folder's files");
	assert.equal(ignored("app/src/build"), false, "build/ only matches folders");
	assert.equal(createGitignoreFilter(new Map())("app/x.js"), false);
});
