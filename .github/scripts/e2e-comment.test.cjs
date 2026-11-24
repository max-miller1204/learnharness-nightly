// Dry runs of the "Post the comment" step of .github/workflows/e2e-comment.yml
// against a fake `gh`, and the rules that keep the workflow trusted.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");

const workflow = yaml.load(fs.readFileSync(path.join(__dirname, "..", "workflows", "e2e-comment.yml"), "utf8"));
const job = workflow.jobs.comment;
const script = job.steps.find((step) => step.name === "Post the comment").run;

// A `gh` that logs each call and answers the three the script makes.
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
[ -n "$FAKE_FAIL" ] && { echo "gh: HTTP 403: Resource not accessible by integration" >&2; exit 1; }
case "$*" in
  *"/pulls/"*) echo "$FAKE_HEAD" ;;
  *"--paginate"*) [ -n "$FAKE_COMMENT_ID" ] && echo "$FAKE_COMMENT_ID" || true ;;
  *"-F body=@"*) for a in "$@"; do case "$a" in body=@*) cp "\${a#body=@}" "$FAKE_BODY" ;; esac; done ;;
esac
`;

function run({ summary, head = "abc1234def5678", commentId = "", pr = "444", fail = "" }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-comment-"));
	const bin = path.join(dir, "bin");
	const temp = path.join(dir, "temp");
	const summaryDir = path.join(temp, "e2e-summary");
	fs.mkdirSync(bin);
	fs.mkdirSync(summaryDir, { recursive: true });
	fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
	if (summary !== undefined) fs.writeFileSync(path.join(summaryDir, "summary.md"), summary);
	const log = path.join(dir, "log"), body = path.join(dir, "posted.md");
	fs.writeFileSync(log, "");
	const result = spawnSync("bash", ["-c", script], {
		env: {
			PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: temp, SUMMARY_DIR: summaryDir,
			GH_REPO: "o/r", PR_NUMBER: pr, HEAD_SHA: "abc1234def5678", RUN_URL: "https://example.test/run/1", RUN_ATTEMPT: "2", RUN_CONCLUSION: "success",
			FAKE_LOG: log, FAKE_BODY: body, FAKE_HEAD: head, FAKE_COMMENT_ID: commentId, FAKE_FAIL: fail,
		},
		encoding: "utf8",
	});
	const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
	const postedBytes = fs.existsSync(body) ? fs.readFileSync(body) : undefined;
	const posted = postedBytes?.toString("utf8");
	fs.rmSync(dir, { recursive: true });
	return { ...result, calls, posted, postedBytes };
}

const MARKER = "<!-- learnharness-e2e-summary -->";

test("a summary becomes a new comment: marker, then a header from GitHub metadata, then the summary", () => {
	const r = run({ summary: "### e2e: 2 passed\n" });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.calls.some((c) => c.startsWith("api -X POST repos/o/r/issues/444/comments")));
	const [first, header, , summary] = r.posted.split("\n");
	assert.equal(first, MARKER);
	assert.equal(header, "**e2e** for commit `abc1234`, [CI run](https://example.test/run/1) attempt 2, conclusion: success");
	assert.equal(summary, "### e2e: 2 passed");
});

test("nothing in the summary can come before or swallow the header", () => {
	const r = run({ summary: "<!-- an unclosed comment\n**e2e** for commit `0000000`\n" });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.posted.startsWith(`${MARKER}\n**e2e** for commit \`abc1234\``));
	assert.ok(r.posted.indexOf("abc1234") < r.posted.indexOf("<!-- an unclosed"));
});

test("an existing comment is edited, not duplicated", () => {
	const r = run({ summary: "### e2e: 1 failed\n", commentId: "9001" });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.calls.some((c) => c.startsWith("api -X PATCH repos/o/r/issues/comments/9001")));
	assert.ok(!r.calls.some((c) => c.includes("-X POST")));
});

test("a cut that splits a 3-byte character posts valid UTF-8 within the limit", () => {
	// One byte of offset, so the 60000-byte cut lands inside a euro sign.
	const r = run({ summary: "a" + "\u20ac".repeat(30_000) });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.calls.some((c) => c.startsWith("api -X POST")), "the comment is still posted");
	assert.ok(r.postedBytes.length <= 60_400, `${r.postedBytes.length} bytes`);
	assert.ok(!r.posted.includes("\uFFFD"), "no replacement character");
	assert.ok(r.posted.endsWith("\u20ac"), "the cut ends on a whole character");
	assert.equal(Buffer.from(r.posted, "utf8").equals(r.postedBytes), true, "a clean round trip");
});

test("every @ is defused, also when the summary is mostly @ and gets cut", () => {
	const r = run({ summary: "@a @b\n".repeat(20_000) + "tail @z" });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.posted.includes("@\u200ba"));
	assert.ok(!/@(?!\u200b)/.test(r.posted), "no @ without a zero-width space after it");
	assert.ok(r.postedBytes.length <= 60_400);
});

test("invalid UTF-8 and control characters are dropped, tabs and newlines stay", () => {
	const r = run({ summary: Buffer.concat([Buffer.from("ok\tline\nx"), Buffer.from([0xff, 0xfe, 0x00, 0x1b]), Buffer.from("y\n")]) });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.posted.endsWith("ok\tline\nxy\n"));
});

test("with no summary, a stale comment is replaced by a note and nothing new is posted", () => {
	const stale = run({ commentId: "9001" });
	assert.equal(stale.status, 0, stale.stderr);
	assert.ok(stale.calls.some((c) => c.startsWith("api -X PATCH repos/o/r/issues/comments/9001")));
	assert.match(stale.posted, /No e2e summary was written for this run\./);
	assert.match(stale.posted, /commit `abc1234`/);
	const none = run({});
	assert.equal(none.status, 0, none.stderr);
	assert.ok(!none.calls.some((c) => c.includes("-X POST") || c.includes("-X PATCH")));
});

test("a run for an older commit, or without a pull request, posts nothing", () => {
	const old = run({ summary: "x", head: "def456" });
	assert.equal(old.status, 0, old.stderr);
	assert.ok(!old.calls.some((c) => c.includes("-X ")));
	const fork = run({ summary: "x", pr: "" });
	assert.equal(fork.status, 0, fork.stderr);
	assert.deepEqual(fork.calls, []);
});

test("a read-only token or an API error never fails the step", () => {
	const r = run({ summary: "### e2e\n", fail: "1" });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /::warning::the e2e comment was not posted/);
});

test("the workflow checks out nothing, skips what it should, never fails, and is the only write token holder", () => {
	assert.deepEqual(workflow.on, { workflow_run: { workflows: ["CI"], types: ["completed"] } });
	assert.deepEqual(workflow.permissions, {});
	assert.deepEqual(job.permissions, { actions: "read", "pull-requests": "write" });
	assert.ok(job.steps.every((step) => !step.uses || !step.uses.startsWith("actions/checkout")));
	assert.match(job.if, /workflow_run\.path == '\.github\/workflows\/ci\.yml'/);
	assert.match(job.if, /workflow_run\.conclusion != 'cancelled'/);
	assert.match(job.if, /triggering_actor\.login != 'dependabot\[bot\]'/);
	const post = job.steps.find((step) => step.name === "Post the comment");
	assert.equal(post["continue-on-error"], true);
	assert.match(post.run, /exit 0\s*$/);
	const download = job.steps.find((step) => step.uses === "actions/download-artifact@v8");
	assert.equal(download["continue-on-error"], true);
	assert.equal(download.with.name, "e2e-summary-${{ github.event.workflow_run.run_attempt }}");
	assert.equal(download.with["run-id"], "${{ github.event.workflow_run.id }}");
	const ci = yaml.load(fs.readFileSync(path.join(__dirname, "..", "workflows", "ci.yml"), "utf8"));
	assert.equal(ci.permissions["pull-requests"], undefined, "CI itself never holds a write token");
	for (const [id, other] of Object.entries(ci.jobs)) assert.equal(other.permissions?.["pull-requests"], undefined, `ci.yml ${id}`);
	const uploads = ci.jobs.standalone.steps.filter((step) => step.uses === "actions/upload-artifact@v7" && String(step.with.name).startsWith("e2e-"));
	assert.equal(uploads.length, 2);
	for (const step of uploads) assert.equal(step.with["include-hidden-files"], true, `${step.name}: .e2e/ is hidden`);
	const summaryUpload = uploads.find((step) => String(step.with.name).startsWith("e2e-summary"));
	assert.equal(summaryUpload.with.name, "e2e-summary-${{ github.run_attempt }}", "the same attempt the commenter downloads");
	assert.equal(summaryUpload["continue-on-error"], true);
});
