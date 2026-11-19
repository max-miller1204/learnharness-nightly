// link-check-ignore-file: the fixtures below name missing paths on purpose.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { check, trackedFiles } = require("./link-check.cjs");

const repoRoot = path.resolve(__dirname, "../..");

/** Writes the files into a fresh folder and checks exactly those files. */
function checkFixture(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "link-check-"));
	try {
		for (const [file, text] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), text);
		}
		return check({ root, files: Object.keys(files) });
	} finally {
		fs.rmSync(root, { recursive: true });
	}
}

const clean = {
	"README.md": [
		"See [the guide](docs/guide.md), [a section](docs/guide.md#setup), [the folder](docs/) and [home](/README.md).",
		"![logo](docs/assets/logo.png) [web](https://example.com/missing.md) [mail](mailto:a@example.com) [here](#top)",
		"[spaced](<docs/a file.md>) [encoded](docs/a%20file.md) [titled](docs/guide.md \"Guide\")",
		"[ref]: docs/guide.md",
		"Inline code is not a link: `[x](docs/missing.md)`.",
		"```md",
		"[fenced](docs/missing.md)",
		"```",
		"[fixture](docs/missing.md) <!-- link-check-ignore -->",
	].join("\n"),
	"docs/guide.md": "Back to [the readme](../README.md).\n",
	"docs/a file.md": "",
	"docs/assets/logo.png": "png",
	"src/app.ts": [
		"// Design: docs/guide.md, also docs/assets/.",
		"const name = `docs/${file}`;",
		"const url = \"https://example.com/docs/missing.md\";",
		"write(\"docs/missing.md\"); // link-check-ignore: fixture",
	].join("\n"),
};

test("a clean set of files passes", () => {
	assert.deepEqual(checkFixture(clean), []);
});

test("a Markdown link to a missing file fails", () => {
	const problems = checkFixture({ ...clean, "docs/guide.md": "Back to [the readme](../README.md).\n\nSee [the plan](plan.md#later).\n" });
	assert.deepEqual(problems, [{ file: "docs/guide.md", line: 3, target: "plan.md#later" }]);
});

test("a reference-style link and a link out of the repository fail", () => {
	const problems = checkFixture({ ...clean, "docs/guide.md": "[ref]: gone.md\n[up](../../outside.md)\n" });
	assert.deepEqual(problems, [
		{ file: "docs/guide.md", line: 1, target: "gone.md" },
		{ file: "docs/guide.md", line: 2, target: "../../outside.md" },
	]);
});

test("a missing docs/ path named in a code comment fails", () => {
	const problems = checkFixture({ ...clean, "src/app.ts": "/** The split (docs/archive/split.md §2). */\n" });
	assert.deepEqual(problems, [{ file: "src/app.ts", line: 1, target: "docs/archive/split.md" }]);
});

test("a footnote definition is not a link", () => {
	assert.deepEqual(checkFixture({ ...clean, "docs/guide.md": "Text.[^1]\n\n[^1]: A footnote with words.\n" }), []);
	assert.deepEqual(checkFixture({ ...clean, "docs/guide.md": "[^1]: A footnote.\n[ref]: gone.md\n" }), [{ file: "docs/guide.md", line: 2, target: "gone.md" }]);
});

test("a glob or template docs/ path is skipped, a plain one next to it is still checked", () => {
	const problems = checkFixture({ ...clean, "src/app.ts": "// docs/plugin-*.md, docs/specs/${name}.md, docs/{a,b}.md\n// docs/gone.md\n" });
	assert.deepEqual(problems, [{ file: "src/app.ts", line: 2, target: "docs/gone.md" }]);
});

test("a file whose first line has the file marker is skipped", () => {
	assert.deepEqual(checkFixture({ ...clean, "src/fixture.ts": "// link-check-ignore-file\nwrite(\"docs/missing.md\");\n" }), []);
	assert.deepEqual(checkFixture({ ...clean, "src/fixture.ts": "\n// link-check-ignore-file\nwrite(\"docs/missing.md\");\n" }), [{ file: "src/fixture.ts", line: 3, target: "docs/missing.md" }]);
});

test("the repository's tracked files have no dead links", () => {
	const problems = check({ root: repoRoot, files: trackedFiles(repoRoot) });
	assert.deepEqual(problems, []);
});
