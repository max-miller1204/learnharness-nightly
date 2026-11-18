/**
 * The upstream PR import and issue mirror scripts, run offline: `gh`, `git`
 * and `sleep` are stubs on PATH that answer from fixtures and log each call,
 * and a `jq` wrapper can inject a failure. Covers the hardening in
 * docs/specs/fix-upstream-hardening.md: copied text can't close its code
 * block, only the fork bot's issues count as mirrors, writes happen only in
 * the workflow, and a jq error fails the run. Both bodies link the upstream
 * item by URL (docs/specs/simplify-upstream-intake.md).
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
for a in "$@"; do [ "$a" = --input ] && cat >"$d/calls/$n.md"; done
case "$1 \${2:-}" in
	"api "*) p="\${!#}"; f="$d/api/$(printf %s "$p" | tr -c 'A-Za-z0-9' _)"; if [ -f "$d/fail/$(printf %s "$p" | tr -c 'A-Za-z0-9' _)" ]; then echo "gh: HTTP 403" >&2; exit 1; elif [ -f "$f" ]; then cat "$f"; else echo '[]'; fi ;;
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
	fs.mkdirSync(path.join(dir, "fail"));
	fs.mkdirSync(path.join(dir, "gitcalls"));
	const stub = (name: string, text: string) => fs.writeFileSync(path.join(dir, "bin", name), text, { mode: 0o755 });
	stub("gh", GH_STUB);
	stub("jq", JQ_WRAPPER);
	// git logs argv to gitcalls/<n> and answers `diff` from git-diff.txt (the
	// files an imported PR changes).
	stub("git", `#!/usr/bin/env bash
n=$(( $(find "$STUB_DIR/gitcalls" -type f | wc -l) + 1 ))
printf '%s\\0' "$@" >"$STUB_DIR/gitcalls/$n"
if [ "$1" = diff ] && [ -f "$STUB_DIR/git-diff.txt" ]; then cat "$STUB_DIR/git-diff.txt"; fi
exit 0
`);
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
			GH_TOKEN: "test-token",
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

function gitCalls() {
	const names = fs.readdirSync(path.join(dir, "gitcalls")).sort((a, b) => Number(a) - Number(b));
	return names.map((name) => fs.readFileSync(path.join(dir, "gitcalls", name), "utf8").split("\0").slice(0, -1));
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

// GitHub treats a fence over 255 tildes as 255, so a line of 255+ tildes could
// close any fence. Text with such a run takes the indenting path.
const LONG = `${HOSTILE}\n${"~".repeat(255)}\n@octocat #3\r  ${"~".repeat(300)}\r\n@octocat #4\n\t${"~".repeat(400)}\nend`;

/**
 * The copied text must sit inside one block whose fence is longer than any
 * tilde run in it: verbatim, or for a run of 255+ in a 255-tilde fence with LF
 * line endings and every line that could close it indented to 4 spaces.
 */
function assertFenced(rendered: string, text: string) {
	const longest = Math.max(0, ...(text.match(/~+/g) ?? []).map((run) => run.length));
	let fence = "~".repeat(Math.max(4, longest + 1));
	let inside = text;
	if (longest >= 255) {
		fence = "~".repeat(255);
		inside = text.split(/\r\n|\r|\n/).map((line) => line.replace(/^ {0,3}(?=~)/, "    ")).join("\n");
		assert.ok(!/\r/.test(inside) && !/^ {0,3}~/m.test(inside));
	}
	assert.ok(rendered.includes(`\n${fence}markdown\n${inside}\n${fence}\n`), `expected a ${fence.length}-tilde block holding the text:\n${rendered}`);
}

describe("mirror-upstream-issues.sh", () => {
	it("fences hostile issue and comment text so nothing inside can close the block", () => {
		fixture(`repos/${UP}/issues/10`, issue(10, "open", HOSTILE));
		fixture(`repos/${UP}/issues/10/comments?per_page=100`, [{ user: { login: "commenter" }, created_at: "2026-11-02T00:00:00Z", body: `${HOSTILE}\n~~~~~~~~~~~~~~~~~~~~` }]);
		const { status, stderr, calls } = run("mirror-upstream-issues.sh", ["10"]);
		assert.equal(status, 0, stderr);
		const created = calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");
		assert.equal(created.length, 1);
		const body = created[0]?.body ?? "";
		assert.ok(body.startsWith(`<!-- upstream-issue: ${UP}#10 -->\nMirrored from https://github.com/${UP}/issues/10, opened by \``), body);
		assertFenced(body, HOSTILE);
		assertFenced(body, `${HOSTILE}\n~~~~~~~~~~~~~~~~~~~~`);
		assert.match(body, /\n~{21}markdown\n/); // one longer than the comment's 20-tilde run
	});

	it("indents closing-capable lines when the text has a run of 255+ tildes", () => {
		fixture(`repos/${UP}/issues/10`, issue(10, "open", LONG));
		fixture(`repos/${UP}/issues/10/comments?per_page=100`, [{ user: { login: "commenter" }, created_at: "2026-11-02T00:00:00Z", body: LONG }]);
		const { status, stderr, calls } = run("mirror-upstream-issues.sh", ["10"]);
		assert.equal(status, 0, stderr);
		const body = calls.find((c) => c.args[0] === "issue" && c.args[1] === "create")?.body ?? "";
		assertFenced(body, LONG);
		assert.equal(body.match(new RegExp(`\n${"~".repeat(255)}markdown\n`, "g"))?.length, 2);
	});

	it("mirrors only the picked issue, with its labels, and never lists upstream's issues", () => {
		fixture(`repos/${UP}/issues/11`, issue(11, "closed", "eleven", ["bug", "not-here"]));
		const { status, stderr, stdout, calls } = run("mirror-upstream-issues.sh", ["11"]);
		assert.equal(status, 0, stderr);
		const create = calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");
		assert.equal(create.length, 1);
		const args = create[0]?.args ?? [];
		assert.equal(args[args.indexOf("--title") + 1], "[upstream issue 11] Issue 11");
		assert.deepEqual(args.filter((_, i) => args[i - 1] === "--label"), ["bug", "upstream", "upstream-closed"]);
		assert.ok(!calls.some((c) => c.args[0] === "api" && c.args.at(-1)?.startsWith(`repos/${UP}/issues?`)), JSON.stringify(calls));
		assert.match(stdout, /Mirrored 1 upstream issue\(s\)\. upstream-closed: 0 added, 0 removed\./);
	});

	it("creates nothing without a number, and skips an issue that's already mirrored", () => {
		fixture(`repos/${FORK}/issues?state=all&per_page=100`, [forkIssue(7, BOT, 11)]);
		fixture(`repos/${UP}/issues/11`, issue(11, "open", "eleven"));
		for (const args of [[], ["11"]]) {
			const { status, stderr, stdout, calls } = run("mirror-upstream-issues.sh", args);
			assert.equal(status, 0, stderr);
			assert.ok(!calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"), JSON.stringify(calls));
			assert.match(stdout, /Mirrored 0 upstream issue\(s\)/);
			if (args.length) assert.match(stdout, /Upstream issue 11 is already mirrored\./);
		}
	});

	it("refuses an upstream PR number", () => {
		fixture(`repos/${UP}/issues/12`, { ...issue(12, "open", "a PR"), pull_request: { url: "x" } });
		const { status, stderr, calls } = run("mirror-upstream-issues.sh", ["12"]);
		assert.equal(status, 1);
		assert.match(stderr, /is a PR; import it with Import upstream PR instead/);
		assert.ok(!calls.some((c) => c.args[0] === "issue"));
	});

	it("keeps upstream-closed matching upstream, for the fork bot's mirrors only", () => {
		fixture(`repos/${FORK}/issues?state=all&per_page=100`, [
			forkIssue(5, "mallory", 10), // fake marker: never read or edited
			forkIssue(6, "mallory", 12, ["upstream-closed"]), // fake marker the label pass would otherwise edit
			forkIssue(7, BOT, 11), // real mirror of a closed issue, missing the label
			forkIssue(8, BOT, 12, ["upstream-closed"]), // real mirror of a reopened issue
			forkIssue(9, BOT, 13, ["upstream-closed"]), // real mirror, already right
		]);
		fixture(`repos/${UP}/issues/11`, issue(11, "closed", "eleven"));
		fixture(`repos/${UP}/issues/12`, issue(12, "open", "twelve"));
		fixture(`repos/${UP}/issues/13`, issue(13, "closed", "thirteen"));
		const { status, stderr, stdout, calls } = run("mirror-upstream-issues.sh", []);
		assert.equal(status, 0, stderr);
		const reads = calls.filter((c) => c.args[0] === "api" && /issues\/\d+$/.test(c.args.at(-1) ?? "")).map((c) => c.args.at(-1));
		assert.deepEqual(reads, [`repos/${UP}/issues/11`, `repos/${UP}/issues/12`, `repos/${UP}/issues/13`]);
		const edits = calls.filter((c) => c.args[0] === "issue" && c.args[1] === "edit").map((c) => c.args.join(" "));
		assert.deepEqual(edits, [`issue edit 7 -R ${FORK} --add-label upstream-closed`, `issue edit 8 -R ${FORK} --remove-label upstream-closed`]);
		assert.match(stdout, /upstream-closed: 1 added, 1 removed\./);
	});

	it("relabels the other mirrors when one upstream issue can't be read, then fails", () => {
		fixture(`repos/${FORK}/issues?state=all&per_page=100`, [forkIssue(7, BOT, 11), forkIssue(8, BOT, 12)]);
		fs.writeFileSync(path.join(dir, "fail", `repos/${UP}/issues/11`.replace(/[^A-Za-z0-9]/g, "_")), "");
		fixture(`repos/${UP}/issues/12`, issue(12, "closed", "twelve"));
		const { status, stderr, calls } = run("mirror-upstream-issues.sh", []);
		assert.equal(status, 1);
		assert.match(stderr, /Couldn't read upstream issue 11 \(mirror #7\)/);
		assert.deepEqual(calls.filter((c) => c.args[1] === "edit").map((c) => c.args.join(" ")), [`issue edit 8 -R ${FORK} --add-label upstream-closed`]);
	});

	it("refuses to write outside the workflow, and writes nothing on a dry run", () => {
		fixture(`repos/${UP}/issues/10`, issue(10, "open", "ten"));
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

	for (const [step, marker, args] of [["picked issue", "{number, state, title", ["10"]], ["label list", "$have[0]", ["10"]], ["mirror list", "upstream-closed\") != null", []]] as const) {
		it(`fails the run when jq fails while building the ${step}`, () => {
			fixture(`repos/${UP}/issues/10`, issue(10, "open", "ten", ["bug"]));
			fixture(`repos/${UP}/issues/11`, issue(11, "closed", "eleven"));
			fixture(`repos/${FORK}/issues?state=all&per_page=100`, [forkIssue(7, BOT, 11)]);
			const { status, stderr, stdout, calls } = run("mirror-upstream-issues.sh", [...args], { JQ_FAIL_ON: marker });
			assert.notEqual(status, 0, stdout);
			assert.match(stderr, /jq: injected failure/);
			assert.doesNotMatch(stdout, /Mirrored/);
			assert.ok(!calls.some((c) => c.args[0] === "issue"), JSON.stringify(calls));
		});
	}

	it("renders many long tilde-heavy comments quickly and still fits the size cap", () => {
		const heavy = "~ ".repeat(32000);
		fixture(`repos/${UP}/issues/10`, issue(10, "open", heavy));
		fixture(`repos/${UP}/issues/10/comments?per_page=100`, Array.from({ length: 30 }, () => ({ user: { login: "c" }, created_at: "2026-11-02T00:00:00Z", body: heavy })));
		const started = Date.now();
		const { status, stderr, calls } = run("mirror-upstream-issues.sh", ["10"]);
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
		title: "A PR", user: { login: "author" }, html_url: `https://github.com/${UP}/pull/7`, state: "open", merged: false, body, base: { ref: "main" },
	});

	it("starts the body with the upstream PR's URL and the author as code", () => {
		fixture(`repos/${UP}/pulls/7`, pr("desc"));
		const { status, stderr, calls } = run("import-upstream-pr.sh", ["7"]);
		assert.equal(status, 0, stderr);
		const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
		assert.ok(create?.body?.startsWith(`Imported from https://github.com/${UP}/pull/7 by \`author\` (upstream state: open).\n`), create?.body);
		assert.ok(!create?.body?.includes("Upstream:"), create?.body);
	});

	it("refuses a PR that changes .github/ unless allowed, before pushing anything", () => {
		fixture(`repos/${UP}/pulls/7`, pr("desc"));
		fs.writeFileSync(path.join(dir, "git-diff.txt"), ".github/workflows/evil.yml\n");
		const refused = run("import-upstream-pr.sh", ["7"]);
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /Upstream PR 7 changes \.github\/:\n {2}\.github\/workflows\/evil\.yml\n/);
		assert.match(refused.stderr, /re-run with allow_github_changes/);
		assert.ok(!refused.calls.some((c) => c.args[0] === "pr"), JSON.stringify(refused.calls));
		const git = gitCalls();
		assert.deepEqual(git.map((args) => args[0]), ["fetch", "diff"]);
		assert.deepEqual(git[0]?.slice(-2), ["+refs/pull/7/head:refs/remotes/upstream-pr/7", "+refs/heads/main:refs/remotes/upstream-base/7"]);
		assert.deepEqual(git[1], ["diff", "--no-renames", "--name-only", "refs/remotes/upstream-base/7...refs/remotes/upstream-pr/7", "--", ".github"]);
		for (const allow of ["1", "true"]) {
			fs.rmSync(path.join(dir, "gitcalls"), { recursive: true });
			fs.mkdirSync(path.join(dir, "gitcalls"));
			const allowed = run("import-upstream-pr.sh", ["7"], { ALLOW_GITHUB_CHANGES: allow });
			assert.equal(allowed.status, 0, allowed.stderr);
			assert.deepEqual(gitCalls().map((args) => args.slice(0, 2)), [["fetch", "--no-tags"], ["diff", "--no-renames"], ["push", "--force"]]);
		}
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

	it("indents closing-capable lines when the description has a run of 255+ tildes", () => {
		fixture(`repos/${UP}/pulls/7`, pr(LONG));
		const { status, stderr, calls } = run("import-upstream-pr.sh", ["7"]);
		assert.equal(status, 0, stderr);
		const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
		assertFenced(create?.body ?? "", LONG);
	});

	it("writes (none) for an empty description", () => {
		fixture(`repos/${UP}/pulls/7`, pr(null));
		const { status, stderr, calls } = run("import-upstream-pr.sh", ["7"]);
		assert.equal(status, 0, stderr);
		const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
		assert.match(create?.body ?? "", /\n~~~~markdown\n\(none\)\n~~~~\n\n<\/details>\n$/);
	});
});
