const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { decide } = require("./ci-changes.cjs");

const none = { typecheck: false, test: false, selfhost: false, standalone: false, mobile: false };
const all = { typecheck: true, test: true, selfhost: true, standalone: true, mobile: false };

test("docs-only and other inert changes skip every gated job", () => {
	assert.deepEqual(decide(["docs/self-hosting.md", "README.md", ".claude/skills/x/SKILL.md", ".github/workflows/pr-agent.yml", "docs/specs/ci-foundation.md"]), none);
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
	assert.deepEqual(decide(["docs/self-hosting.md"], true), { ...all, mobile: true });
	assert.deepEqual(decide(null), { ...all, mobile: true });
});

test("the command line prints one gate per line for GITHUB_OUTPUT", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-changes-"));
	try {
		const list = path.join(dir, "paths");
		fs.writeFileSync(list, "docs/a.md\ntests/jobs.test.ts\n"); // link-check-ignore: fixture path
		const script = path.join(__dirname, "ci-changes.cjs");
		const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		assert.equal(run("--paths", list), "typecheck=true\ntest=true\nselfhost=false\nstandalone=false\nmobile=false\n");
		assert.equal(run("--paths", list, "--full"), "typecheck=true\ntest=true\nselfhost=true\nstandalone=true\nmobile=true\n");
		assert.equal(run(), "typecheck=true\ntest=true\nselfhost=true\nstandalone=true\nmobile=true\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
