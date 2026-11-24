const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { decide, pathsFile } = require("./ci-changes.cjs");

const none = { typecheck: false, test: false, selfhost: false, standalone: false, mobile: false };
const all = { typecheck: true, test: true, selfhost: true, standalone: true, mobile: false };

test("docs-only and other inert changes skip every gated job", () => {
	assert.deepEqual(decide(["docs/self-hosting.md", "README.md", ".claude/skills/x/SKILL.md", ".agents/skills/x/SKILL.md", ".mcp.json", ".codex/config.toml", ".github/workflows/pr-agent.yml", "docs/specs/ci-foundation.md"]), none);
});

test("docs the app or plugin-authoring bundle ships run everything", () => {
	for (const file of ["docs/plugin-authoring.md", "docs/dialog-overlay-contract.md", "docs/plugin-api/README.md", "docs/compaction-accounting.md", "LICENSE", "docs/development.md"]) {
		assert.deepEqual(decide([file]), all, file);
	}
});

test("TypeScript under an inert folder is still typechecked and tested", () => {
	assert.deepEqual(decide([".claude/skills/x/tool.ts"]), { ...none, typecheck: true, test: true });
});

test("test-only changes run typecheck and tests but no standalone build", () => {
	assert.deepEqual(decide(["tests/jobs.test.ts", "tests/demos.test.tsx"]), { ...none, typecheck: true, test: true });
});

test("native renderer tests, helpers and fixtures also run the standalone builds", () => {
	for (const file of ["tests/pdf-native-render.test.ts", "tests/browser-service.test.ts", "tests/helpers/tiny-pdf.ts", "tests/fixtures/a.json"]) {
		assert.deepEqual(decide([file]), all, file);
	}
});

test("app code, workflows, the launcher and unknown paths run everything", () => {
	for (const file of ["src/server/self-update.ts", ".github/workflows/ci.yml", ".github/scripts/ci-changes.cjs", "selfhost/lh.ts", "package-lock.json", "plugins/flashcards/x.js", "some-new-dir/file"]) {
		assert.deepEqual(decide([file]), { ...all, mobile: file.startsWith(".github/") || file === "package-lock.json" }, file);
	}
});

test("mobile changes use the isolated gate and shared core changes use both", () => {
	assert.deepEqual(decide(["apps/mobile/package-lock.json"]), { ...none, mobile: true });
	assert.deepEqual(decide(["src/client-protocol/index.ts"]), { ...all, mobile: true });
	assert.deepEqual(decide(["src/core/view.ts"]), { ...all, mobile: true });
	assert.deepEqual(decide(["public/fonts/cmunbx.ttf"]), { ...all, mobile: true });
});

test("one non-inert file in a docs change runs its gates", () => {
	assert.deepEqual(decide(["docs/self-hosting.md", "tests/jobs.test.ts"]), { ...none, typecheck: true, test: true });
	assert.deepEqual(decide(["docs/self-hosting.md", "app/page.tsx"]), all);
});

test("--full and an unknown diff fail open", () => {
	assert.deepEqual(decide(null, true), { ...all, mobile: true });
	assert.deepEqual(decide(null), { ...all, mobile: true });
});

test("the command line prints one gate per line for GITHUB_OUTPUT", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-changes-"));
	try {
		const list = path.join(dir, "paths");
		fs.writeFileSync(list, "docs/a.md\0tests/jobs.test.ts\0");
		const script = path.join(__dirname, "ci-changes.cjs");
		const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		assert.equal(run("--paths", list), "typecheck=true\ntest=true\nselfhost=false\nstandalone=false\nmobile=false\n");
		assert.equal(run("--paths", list, "--full"), "typecheck=true\ntest=true\nselfhost=true\nstandalone=true\nmobile=true\n");
		assert.equal(run("--full"), "typecheck=true\ntest=true\nselfhost=true\nstandalone=true\nmobile=true\n");
		assert.equal(run(), "typecheck=true\ntest=true\nselfhost=true\nstandalone=true\nmobile=true\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("names Git would quote (non-ASCII, a newline) reach the gates as they are, from a pull request's diff file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-quoted-"));
	try {
		// Default Git settings, so core.quotePath is on, as on the runner.
		const git = (...args) => execFileSync("git", ["-c", "core.quotePath=true", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		git("init", "-q");
		fs.writeFileSync(path.join(dir, "README.md"), "base");
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base");
		const names = [
			"apps/mobile/src/\u00e9.ts",
			// Git never quoted a space; kept as a guard that splitting stays NUL-only.
			"apps/mobile/src/course notes.ts",
			// Windows can't create a name with a newline.
			...(process.platform === "win32" ? [] : ["docs/line\nbreak.md"]),
		];
		for (const name of names) {
			fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
			fs.writeFileSync(path.join(dir, name), name);
		}
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "names");
		const gates = { ...none, mobile: true };
		const expected = [...names].sort();

		// A pull request: ci.yml writes the diff to a file, the same command as the workflow's.
		const list = path.join(dir, ".git", "changed-paths");
		fs.writeFileSync(list, git("diff", "-z", "--name-only", "--no-renames", "HEAD^1", "HEAD"));
		// The parser keeps every name exactly, including the non-ASCII one and the newline.
		assert.deepEqual(pathsFile(fs.readFileSync(list, "utf8")).sort(), expected);
		const script = path.join(__dirname, "ci-changes.cjs");
		const out = execFileSync(process.execPath, [script, "--paths", list], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		assert.equal(out, Object.entries(gates).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a --paths file that isn't NUL-separated runs every job instead of skipping", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-newline-paths-"));
	try {
		const list = path.join(dir, "paths");
		// The old newline format: read as one name it would match nothing and skip Mobile.
		fs.writeFileSync(list, "docs/a.md\napps/mobile/src/App.tsx\n");
		const script = path.join(__dirname, "ci-changes.cjs");
		const run = () => execFileSync(process.execPath, [script, "--paths", list], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		assert.equal(run(), "typecheck=true\ntest=true\nselfhost=true\nstandalone=true\nmobile=true\n");
		// An empty diff is still an empty diff.
		fs.writeFileSync(list, "");
		assert.equal(run(), "typecheck=false\ntest=false\nselfhost=false\nstandalone=false\nmobile=false\n");
		assert.equal(pathsFile("docs/a.md"), null);
		assert.deepEqual(pathsFile("docs/a.md\0"), ["docs/a.md"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
