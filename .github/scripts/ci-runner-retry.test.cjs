const assert = require("node:assert/strict");
const test = require("node:test");
const { classify, MAX_RETRIES } = require("./ci-runner-retry.cjs");

// Shapes and annotation texts copied from real runs of this repo's CI.
const NOT_ACQUIRED = "The job was not acquired by Runner of type hosted even after multiple attempts";
const CAPACITY = "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times.";
const CONCURRENCY = "Canceling since a higher priority waiting request for ci-8 exists";
const OPERATION = "The operation was canceled.";

let nextId = 1;
const passed = (name) => ({ id: nextId++, name, status: "completed", conclusion: "success", runner_id: 1000013793, runner_name: "GitHub Actions 1000013793", steps: [{}, {}] });
// Run 44135265518, job 134223289271: queued, never assigned a runner.
const noRunnerMac = () => ({ id: nextId++, name: "Standalone (mac-arm64)", status: "completed", conclusion: "cancelled", runner_id: 0, runner_name: "", steps: [] });
const check = () => ({ ...passed("Check"), conclusion: "failure" });
const run = (over = {}) => ({ id: 44135265518, event: "pull_request", status: "completed", conclusion: "failure", run_attempt: 1, ...over });

function noRunnerRun(over = {}) {
	const mac = noRunnerMac();
	const jobs = [passed("Changes"), passed("Lint"), passed("Standalone (linux-x64)"), mac, check()];
	return { run: run(over), jobs, annotations: { [mac.id]: [NOT_ACQUIRED, CAPACITY, CAPACITY, CAPACITY] }, mac };
}

test("a job cancelled because no hosted runner picked it up is re-run", () => {
	const input = noRunnerRun();
	assert.deepEqual(classify({ ...input, newestRunId: input.run.id, seenAttempt: 1 }), {
		retry: true,
		reason: "no hosted runner for Standalone (mac-arm64)",
		jobs: ["Standalone (mac-arm64)"],
	});
});

test("pushes to main are re-run too, with no newest-run check", () => {
	const input = noRunnerRun({ event: "push" });
	assert.equal(classify({ ...input, newestRunId: 1 }).retry, true);
});

test("a real failure is never re-run, even beside a no-runner cancel", () => {
	const failing = { ...passed("Test 3"), conclusion: "failure" };
	assert.deepEqual(classify({ run: run(), jobs: [passed("Changes"), failing, check()], annotations: {} }), {
		retry: false,
		reason: "Test 3 concluded failure, a real failure",
		jobs: [],
	});
	const input = noRunnerRun();
	input.jobs.push({ ...passed("Typecheck"), conclusion: "timed_out" });
	assert.equal(classify(input).retry, false);
});

test("a concurrency cancel is not re-run, even of a job still waiting for a runner", () => {
	// Run 44162620131: the mac job had no runner and no steps, but a newer push cancelled it.
	const mac = noRunnerMac();
	const lint = { ...passed("Lint"), conclusion: "cancelled" };
	const decision = classify({
		run: run({ conclusion: "cancelled" }),
		jobs: [passed("Changes"), lint, mac, check()],
		annotations: { [lint.id]: [CONCURRENCY, OPERATION], [mac.id]: [CONCURRENCY, CAPACITY] },
	});
	assert.equal(decision.retry, false);
	assert.match(decision.reason, /concurrency/);
});

test("a user cancel is not re-run", () => {
	// A cancelled job that had a runner, or one without GitHub's no-runner annotation.
	const running = { ...passed("Standalone (windows-x64)"), conclusion: "cancelled" };
	const queued = noRunnerMac();
	const decision = classify({
		run: run({ conclusion: "cancelled" }),
		jobs: [passed("Changes"), running, queued, check()],
		annotations: { [running.id]: [OPERATION], [queued.id]: ["The run was canceled by @someone."] },
	});
	assert.equal(decision.retry, false);
	assert.match(decision.reason, /not for lack of a runner/);
	const onlyQueued = noRunnerRun();
	onlyQueued.annotations[onlyQueued.mac.id] = [CAPACITY];
	assert.equal(classify(onlyQueued).retry, false);
});

test("the attempt cap stops re-runs", () => {
	assert.equal(MAX_RETRIES, 3);
	assert.equal(classify(noRunnerRun({ run_attempt: MAX_RETRIES })).retry, true);
	const capped = classify(noRunnerRun({ run_attempt: MAX_RETRIES + 1 }));
	assert.equal(capped.retry, false);
	assert.match(capped.reason, /past the cap of 3/);
	assert.equal(classify({ ...noRunnerRun({ run_attempt: 2 }), maxRetries: 1 }).retry, false);
});

test("a superseded or moved-on run is left alone", () => {
	const input = noRunnerRun();
	assert.match(classify({ ...input, newestRunId: input.run.id + 1 }).reason, /newer CI run/);
	assert.match(classify({ ...noRunnerRun({ run_attempt: 2 }), seenAttempt: 1 }).reason, /moved on/);
	assert.match(classify(noRunnerRun({ status: "in_progress" })).reason, /not completed/);
});

test("a passing run, or a failing Check alone, is not re-run", () => {
	assert.equal(classify({ run: run({ conclusion: "success" }), jobs: [passed("Check")], annotations: {} }).retry, false);
	assert.deepEqual(classify({ run: run(), jobs: [passed("Changes"), check()], annotations: {} }).reason, "no job was cancelled for lack of a runner");
});
