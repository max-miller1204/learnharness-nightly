const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { decide, pushPaths } = require("./ci-changes.cjs");

const none = { typecheck: false, test: false, selfhost: false, standalone: false, mobile: false, iphone: false };
const all = { typecheck: true, test: true, selfhost: true, standalone: true, mobile: false, iphone: false };

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
		assert.deepEqual(decide([file]), { ...all, mobile: file.startsWith(".github/") || file === "package-lock.json", iphone: file.startsWith(".github/") || file === "package-lock.json" }, file);
	}
});

test("mobile changes use the isolated gate and shared core changes use both", () => {
	assert.deepEqual(decide(["apps/mobile/package-lock.json"]), { ...none, mobile: true, iphone: true });
	assert.deepEqual(decide(["src/client-protocol/index.ts"]), { ...all, mobile: true, iphone: true });
	assert.deepEqual(decide(["src/core/view.ts"]), { ...all, mobile: true, iphone: true });
	assert.deepEqual(decide(["public/fonts/cmunbx.ttf"]), { ...all, mobile: true, iphone: true });
});

test("the iPhone job's own fixtures and scripts run it, and docs do not", () => {
	for (const file of ["tests/fixtures/mobile-quiz/chat_zzmobilequiz.json", "tests/fixtures/mobile-lesson/job_zzresearch1.json"]) {
		assert.deepEqual(decide([file]), { ...all, iphone: true }, file);
	}
	assert.deepEqual(decide(["scripts/iphone-check/drive.mjs"]), { ...all, iphone: true });
	assert.deepEqual(decide([".claude/skills/prove-learnharness/scripts/start.sh"]), { ...none, iphone: true });
	assert.deepEqual(decide([".claude/skills/prove-learnharness/references/features/mobile-beta.md", "docs/specs/ios-simulator-ci.md"]), none);
});

test("one non-inert file in a docs change runs its gates", () => {
	assert.deepEqual(decide(["docs/self-hosting.md", "tests/jobs.test.ts"]), { ...none, typecheck: true, test: true });
	assert.deepEqual(decide(["docs/self-hosting.md", "app/page.tsx"]), all);
});

test("--full and an unknown diff fail open", () => {
	assert.deepEqual(decide(null, true), { ...all, mobile: true, iphone: true });
	assert.deepEqual(decide(null), { ...all, mobile: true, iphone: true });
});

test("a push to main runs every job, and the iPhone job only when the merge reaches it", () => {
	assert.deepEqual(decide(["docs/self-hosting.md"], true), { ...all, mobile: true, iphone: false });
	assert.deepEqual(decide(["app/page.tsx"], true), { ...all, mobile: true, iphone: false });
	for (const file of ["apps/mobile/src/App.tsx", "tests/fixtures/mobile-quiz/scenario.json", "scripts/iphone-check/drive.mjs", ".github/workflows/ci.yml"]) {
		assert.deepEqual(decide([file], true), { ...all, mobile: true, iphone: true }, file);
	}
});

test("the command line prints one gate per line for GITHUB_OUTPUT", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-changes-"));
	try {
		const list = path.join(dir, "paths");
		fs.writeFileSync(list, "docs/a.md\0tests/jobs.test.ts\0");
		const script = path.join(__dirname, "ci-changes.cjs");
		const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		assert.equal(run("--paths", list), "typecheck=true\ntest=true\nselfhost=false\nstandalone=false\nmobile=false\niphone=false\n");
		assert.equal(run("--paths", list, "--full"), "typecheck=true\ntest=true\nselfhost=true\nstandalone=true\nmobile=true\niphone=false\n");
		assert.equal(run("--full"), "typecheck=true\ntest=true\nselfhost=true\nstandalone=true\nmobile=true\niphone=true\n");
		assert.equal(run(), "typecheck=true\ntest=true\nselfhost=true\nstandalone=true\nmobile=true\niphone=true\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a push is diffed from the commit before it, every commit included, and runs everything when that is unknown", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-push-"));
	try {
		const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const commit = (file) => {
			fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			fs.writeFileSync(path.join(dir, file), file);
			git("add", "-A");
			git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", file);
			return git("rev-parse", "HEAD");
		};
		git("init", "-q");
		const before = commit("README.md");
		commit("apps/mobile/src/App.tsx");
		commit("docs/notes.md");
		// Two merges in one push: the phone change is not the tip, and still counts.
		assert.deepEqual(pushPaths(before, dir), ["apps/mobile/src/App.tsx", "docs/notes.md"]);
		assert.equal(decide(pushPaths(before, dir), true).iphone, true);
		assert.equal(decide(pushPaths(git("rev-parse", "HEAD~1"), dir), true).iphone, false);
		// A new branch's zero SHA, a malformed one, and a commit this clone can't reach run everything.
		for (const unknown of ["0".repeat(40), "", "abc", "f".repeat(40)]) {
			assert.equal(pushPaths(unknown, dir), null, unknown);
			assert.deepEqual(decide(pushPaths(unknown, dir), true), { ...all, mobile: true, iphone: true }, unknown);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("names Git would quote reach the gates as they are, from a pull request's diff file and from a push", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-quoted-"));
	try {
		// Default Git settings, so core.quotePath is on, as on the runner.
		const git = (...args) => execFileSync("git", ["-c", "core.quotePath=true", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		git("init", "-q");
		fs.writeFileSync(path.join(dir, "README.md"), "base");
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base");
		const before = git("rev-parse", "HEAD").trim();
		const names = ["apps/mobile/src/\u00e9.ts", "apps/mobile/src/course notes.ts", "docs/line\nbreak.md"];
		for (const name of names) {
			fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
			fs.writeFileSync(path.join(dir, name), name);
		}
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "names");
		const expected = [...names].sort();
		const gates = { ...none, mobile: true, iphone: true };

		// A push: ci-changes reads the diff itself.
		assert.deepEqual([...pushPaths(before, dir)].sort(), expected);
		assert.deepEqual(decide(pushPaths(before, dir)), gates);

		// A pull request: ci.yml writes the diff to a file, the same command as the workflow's.
		const list = path.join(dir, ".git", "changed-paths");
		fs.writeFileSync(list, git("diff", "-z", "--name-only", "--no-renames", "HEAD^1", "HEAD"));
		const script = path.join(__dirname, "ci-changes.cjs");
		const out = execFileSync(process.execPath, [script, "--paths", list], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		assert.equal(out, Object.entries(gates).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
