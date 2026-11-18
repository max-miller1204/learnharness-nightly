/**
 * The upstream PR import and issue mirror scripts, run offline: `gh`, `git`
 * and `sleep` are stubs on PATH that answer from fixtures and log each call,
 * and a `jq` wrapper can inject a failure. Covers the hardening in
 * docs/specs/fix-upstream-hardening.md: copied text can't close its code
 * block, only the fork bot's issues count as mirrors, writes happen only in
 * the workflow, and a jq error fails the run.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const SCRIPTS = path.join(import.meta.dirname, "..", "scripts");
const UP = "up-owner/up-repo";
const FORK = "fork-owner/fork-repo";
const BOT = "learnharness-nightly-bot[bot]";
const REAL_JQ = execFileSync("bash", ["-c", "command -v jq"], { encoding: "utf8" }).trim();

// Logs argv NUL-separated to calls/<n>, answers `gh api <path>` from
// api/<path with non-alphanumerics as _> (or [] when absent), and keeps each
// --body-file as calls/<n>.md.
const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
d="$STUB_DIR"
n=$(( $(find "$d/calls" -type f ! -name '*.md' | wc -l) + 1 ))
printf '%s\\0' "$@" >"$d/calls/$n"
body_file() { while [ $# -gt 0 ]; do [ "$1" = --body-file ] && { cp "$2" "$d/calls/$n.md"; return; }; shift; done; }
case "$1 \${2:-}" in
	"api "*) p="\${!#}"; f="$d/api/$(printf %s "$p" | tr -c 'A-Za-z0-9' _)"; if [ -f "$f" ]; then cat "$f"; else echo '[]'; fi ;;
	"label list") cat "$d/labels.json" ;;
	"pr list") echo "" ;;
	*) body_file "$@" ;;
esac
`;
const JQ_WRAPPER = `#!/usr/bin/env bash
if [ -n "\${JQ_FAIL_ON:-}" ] && [[ "$*" == *"$JQ_FAIL_ON"* ]]; then echo "jq: injected failure" >&2; exit 5; fi
exec "$REAL_JQ" "$@"
`;

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-upstream-"));
	fs.mkdirSync(path.join(dir, "bin"));
	fs.mkdirSync(path.join(dir, "api"));
	fs.mkdirSync(path.join(dir, "calls"));
	const stub = (name: string, text: string) => fs.writeFileSync(path.join(dir, "bin", name), text, { mode: 0o755 });
	stub("gh", GH_STUB);
	stub("jq", JQ_WRAPPER);
	stub("git", "#!/usr/bin/env bash\nexit 0\n");
	stub("sleep", "#!/usr/bin/env bash\nexit 0\n");
	fs.writeFileSync(path.join(dir, "labels.json"), JSON.stringify(["bug", "upstream", "upstream-closed"]));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(apiPath: string, value: unknown) {
	fs.writeFileSync(path.join(dir, "api", apiPath.replace(/[^A-Za-z0-9]/g, "_")), JSON.stringify(value));
}

function run(script: string, args: string[], env: Record<string, string> = {}) {
	const result = spawnSync("bash", [path.join(SCRIPTS, script), ...args], {
		encoding: "utf8",
		env: {
			NODE_ENV: "test",
			PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
			HOME: dir,
			STUB_DIR: dir,
			REAL_JQ,
			UPSTREAM_REPO: UP,
			FORK_REPO: FORK,
			GITHUB_ACTIONS: "true",
			...env,
		},
	});
	const logged = fs.readdirSync(path.join(dir, "calls")).filter((name) => !name.endsWith(".md")).length;
	const calls = Array.from({ length: logged }, (_, i) => ({
		args: fs.readFileSync(path.join(dir, "calls", String(i + 1)), "utf8").split("\0").slice(0, -1),
		body: readIfExists(path.join(dir, "calls", `${i + 1}.md`)),
	}));
	return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

function readIfExists(file: string) {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
}

const issue = (number: number, state: string, body: string, labels: string[] = []) => ({
	number, state, title: `Issue ${number}`, body, html_url: `https://github.com/${UP}/issues/${number}`,
	created_at: "2026-11-01T00:00:00Z", user: { login: "someone" }, labels: labels.map((name) => ({ name })),
});
const forkIssue = (number: number, login: string, upstream: number, labels: string[] = []) => ({
	number, user: { login }, labels: labels.map((name) => ({ name })),
	body: `<!-- upstream-issue: ${UP}#${upstream} -->\nanything`,
});

// Text that tries to close a ~~~~ fence every way CommonMark allows (column 0,
// up to 3 spaces, tabs, a longer run, CRLF and a lone CR as the line ending)
// and then fire a mention, a #ref, a cross-repo ref and a closing tag.
const HOSTILE = [
	"intro",
	"~~~~",
	"@octocat #1",
	"   ~~~~~~~",
	"\t~~~~",
	"cc @org/team up-owner/up-repo#2\r\n~~~~~~~~~~~~\r\n</details>",
	"lone\r~~~~\r@octocat",
].join("\n");

/** The copied text must sit verbatim inside one block whose fence is longer than any tilde run in it. */
function assertFenced(rendered: string, text: string) {
	const longest = Math.max(0, ...(text.match(/~+/g) ?? []).map((run) => run.length));
	const fence = "~".repeat(Math.max(4, longest + 1));
	assert.ok(rendered.includes(`\n${fence}markdown\n${text}\n${fence}\n`), `expected a ${fence.length}-tilde block holding the text verbatim:\n${rendered}`);
}

describe("mirror-upstream-issues.sh", () => {
	it("fences hostile issue and comment text so nothing inside can close the block", () => {
		fixture(`repos/${UP}/issues?state=all&per_page=100`, [issue(10, "open", HOSTILE)]);
		fixture(`repos/${UP}/issues/10/comments?per_page=100`, [{ user: { login: "commenter" }, created_at: "2026-11-02T00:00:00Z", body: `${HOSTILE}\n~~~~~~~~~~~~~~~~~~~~` }]);
		const { status, stderr, calls } = run("mirror-upstream-issues.sh", []);
		assert.equal(status, 0, stderr);
		const created = calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");
		assert.equal(created.length, 1);
		const body = created[0]?.body ?? "";
		assert.ok(body.startsWith(`<!-- upstream-issue: ${UP}#10 -->\n`));
		assertFenced(body, HOSTILE);
		assertFenced(body, `${HOSTILE}\n~~~~~~~~~~~~~~~~~~~~`);
		assert.match(body, /\n~{21}markdown\n/); // one longer than the comment's 20-tilde run
	});

	it("counts only the fork bot's issues as mirrors, so a fake marker can't block or steer one", () => {
		fixture(`repos/${UP}/issues?state=all&per_page=100`, [issue(10, "open", "ten"), issue(11, "closed", "eleven"), issue(12, "open", "twelve")]);
		fixture(`repos/${FORK}/issues?state=all&per_page=100`, [
			forkIssue(5, "mallory", 10), // fake marker for an unmirrored issue
			forkIssue(6, "mallory", 12, ["upstream-closed"]), // fake marker the label pass would otherwise edit
			forkIssue(7, BOT, 11), // the real mirror of #11, missing upstream-closed
			forkIssue(8, "mallory", 11), // a fake twin of a real mirror
		]);
		const { status, stderr, stdout, calls } = run("mirror-upstream-issues.sh", []);
		assert.equal(status, 0, stderr);
		const titles = calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create").map((c) => c.args[c.args.indexOf("--title") + 1]);
		assert.deepEqual(titles, ["[upstream issue 10] Issue 10", "[upstream issue 12] Issue 12"]);
		const edits = calls.filter((c) => c.args[0] === "issue" && c.args[1] === "edit").map((c) => c.args.join(" "));
		assert.deepEqual(edits, [`issue edit 7 -R ${FORK} --add-label upstream-closed`]);
		assert.match(stdout, /Mirrored 2 new upstream issue\(s\); 0 left for later runs\. upstream-closed: 1 added, 0 removed\./);
	});

	it("refuses to write outside the workflow, and writes nothing on a dry run", () => {
		fixture(`repos/${UP}/issues?state=all&per_page=100`, [issue(10, "open", "ten")]);
		const local = run("mirror-upstream-issues.sh", [], { GITHUB_ACTIONS: "", FORK_REPO: "" });
		assert.equal(local.status, 1);
		assert.match(local.stderr, /run locally with DRY_RUN=1/);
		assert.deepEqual(local.calls, []);

		const dry = run("mirror-upstream-issues.sh", ["10"], { GITHUB_ACTIONS: "", DRY_RUN: "1" });
		assert.equal(dry.status, 0, dry.stderr);
		assert.ok(dry.calls.every((c) => c.args[0] === "api" || (c.args[0] === "label" && c.args[1] === "list")), JSON.stringify(dry.calls));
		assert.match(dry.stdout, /DRY_RUN: gh issue create/);
		assert.match(dry.stdout, /<!-- upstream-issue: up-owner\/up-repo#10 -->/);
	});

	for (const [loop, marker] of [["new-mirror list", ".[:$max]"], ["label list", "$have[0]"], ["label pass", "\\tadd"]] as const) {
		it(`fails the run when jq fails while building the ${loop}`, () => {
			fixture(`repos/${UP}/issues?state=all&per_page=100`, [issue(10, "open", "ten", ["bug"]), issue(11, "closed", "eleven")]);
			fixture(`repos/${FORK}/issues?state=all&per_page=100`, [forkIssue(7, BOT, 11)]);
			const { status, stderr, stdout, calls } = run("mirror-upstream-issues.sh", [], { JQ_FAIL_ON: marker });
			assert.notEqual(status, 0, stdout);
			assert.match(stderr, /jq: injected failure/);
			assert.doesNotMatch(stdout, /Mirrored/);
			if (loop !== "label pass") assert.ok(!calls.some((c) => c.args[0] === "issue"), JSON.stringify(calls));
		});
	}

	it("renders many long tilde-heavy comments quickly and still fits the size cap", () => {
		const heavy = "~ ".repeat(32000);
		fixture(`repos/${UP}/issues?state=all&per_page=100`, [issue(10, "open", heavy)]);
		fixture(`repos/${UP}/issues/10/comments?per_page=100`, Array.from({ length: 30 }, () => ({ user: { login: "c" }, created_at: "2026-11-02T00:00:00Z", body: heavy })));
		const started = Date.now();
		const { status, stderr, calls } = run("mirror-upstream-issues.sh", []);
		const seconds = (Date.now() - started) / 1000;
		assert.equal(status, 0, stderr);
		assert.ok(seconds < 30, `took ${seconds}s`);
		const body = calls.find((c) => c.args[0] === "issue" && c.args[1] === "create")?.body ?? "";
		assert.ok(Buffer.byteLength(body) <= 60000);
		assert.match(body, /\n30 more comments upstream; read them there\.\n/);
	});
});

describe("import-upstream-pr.sh", () => {
	const pr = (body: string | null) => ({
		title: "A PR", user: { login: "author" }, html_url: `https://github.com/${UP}/pull/7`, state: "open", merged: false, body,
	});

	it("fences a hostile description so nothing inside can close the block", () => {
		fixture(`repos/${UP}/pulls/7`, pr(HOSTILE));
		const { status, stderr, calls } = run("import-upstream-pr.sh", ["7"]);
		assert.equal(status, 0, stderr);
		const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
		assert.ok(create?.body, JSON.stringify(calls));
		assert.equal(create.args[create.args.indexOf("--title") + 1], "[upstream PR 7] A PR");
		assertFenced(create.body, HOSTILE);
		assert.match(create.body, /<summary>Original description<\/summary>\n\n~{13}markdown\n[\s\S]*\n~{13}\n\n<\/details>\n$/);
	});

	it("writes (none) for an empty description", () => {
		fixture(`repos/${UP}/pulls/7`, pr(null));
		const { status, stderr, calls } = run("import-upstream-pr.sh", ["7"]);
		assert.equal(status, 0, stderr);
		const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
		assert.match(create?.body ?? "", /\n~~~~markdown\n\(none\)\n~~~~\n\n<\/details>\n$/);
	});
});
