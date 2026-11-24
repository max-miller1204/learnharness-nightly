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
case "$*" in
  *"/pulls/"*) echo "$FAKE_HEAD" ;;
  *"--paginate"*) [ -n "$FAKE_COMMENT_ID" ] && echo "$FAKE_COMMENT_ID" || true ;;
  *"-F body=@"*) for a in "$@"; do case "$a" in body=@*) cp "\${a#body=@}" "$FAKE_BODY" ;; esac; done ;;
esac
`;

function run({ summary, head = "abc123", commentId = "", pr = "444" }) {
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
			GH_REPO: "o/r", PR_NUMBER: pr, HEAD_SHA: "abc123", RUN_URL: "https://example.test/run/1",
			FAKE_LOG: log, FAKE_BODY: body, FAKE_HEAD: head, FAKE_COMMENT_ID: commentId,
		},
		encoding: "utf8",
	});
	const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
	const posted = fs.existsSync(body) ? fs.readFileSync(body, "utf8") : undefined;
	fs.rmSync(dir, { recursive: true });
	return { ...result, calls, posted };
}

test("a summary becomes a new comment with the marker first, mentions defused, and the commit named", () => {
	const r = run({ summary: "### e2e: 2 passed\n\nthanks @someone\n" });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.calls.some((c) => c.startsWith("api -X POST repos/o/r/issues/444/comments")));
	assert.ok(r.posted.startsWith("<!-- learnharness-e2e-summary -->\n### e2e: 2 passed"));
	assert.ok(!r.posted.includes("@someone"));
	assert.ok(r.posted.includes("@​someone"));
	assert.match(r.posted, /Commit abc123, \[CI run\]\(https:\/\/example\.test\/run\/1\)/);
});

test("an existing comment is edited, not duplicated", () => {
	const r = run({ summary: "### e2e: 1 failed\n", commentId: "9001" });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.calls.some((c) => c.startsWith("api -X PATCH repos/o/r/issues/comments/9001")));
	assert.ok(!r.calls.some((c) => c.includes("-X POST")));
});

test("an oversized summary is cut under GitHub's limit, on a character boundary", () => {
	const r = run({ summary: "é".repeat(100_000) });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(Buffer.byteLength(r.posted) < 61_000);
	assert.ok(!r.posted.includes("�"));
});

test("with no summary, a stale comment is replaced by a note and nothing new is posted", () => {
	const stale = run({ commentId: "9001" });
	assert.equal(stale.status, 0, stale.stderr);
	assert.ok(stale.calls.some((c) => c.startsWith("api -X PATCH repos/o/r/issues/comments/9001")));
	assert.match(stale.posted, /No e2e results for commit abc123/);
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

test("the workflow checks out nothing, runs from a finished CI run, and is the only write token holder", () => {
	assert.deepEqual(workflow.on, { workflow_run: { workflows: ["CI"], types: ["completed"] } });
	assert.deepEqual(workflow.permissions, {});
	assert.deepEqual(job.permissions, { actions: "read", "pull-requests": "write" });
	assert.ok(job.steps.every((step) => !step.uses || !step.uses.startsWith("actions/checkout")));
	assert.match(job.if, /workflow_run\.path == '\.github\/workflows\/ci\.yml'/);
	const download = job.steps.find((step) => step.uses === "actions/download-artifact@v8");
	assert.equal(download.with.name, "e2e-summary");
	assert.equal(download.with["run-id"], "${{ github.event.workflow_run.id }}");
	const ci = yaml.load(fs.readFileSync(path.join(__dirname, "..", "workflows", "ci.yml"), "utf8"));
	assert.equal(ci.permissions["pull-requests"], undefined, "CI itself never holds a write token");
	for (const [id, other] of Object.entries(ci.jobs)) assert.equal(other.permissions?.["pull-requests"], undefined, `ci.yml ${id}`);
	const uploads = ci.jobs.standalone.steps.filter((step) => step.uses === "actions/upload-artifact@v7" && String(step.with.name).startsWith("e2e-"));
	assert.equal(uploads.length, 2);
	for (const step of uploads) assert.equal(step.with["include-hidden-files"], true, `${step.name}: .e2e/ is hidden`);
	assert.equal(uploads.find((step) => step.with.name === "e2e-summary")["continue-on-error"], true);
});
