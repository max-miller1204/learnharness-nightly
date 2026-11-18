// Decides whether a finished CI run failed only because GitHub could not give
// a job a hosted runner, and if so re-runs its failed jobs (which re-runs
// `Check` too). Used by .github/workflows/ci-runner-retry.yml. See
// docs/specs/ci-runner-retry.md.
//
//   node ci-runner-retry.cjs --run <id> [--attempt <n>] [--dry-run]
//
// Needs GH_TOKEN (or GITHUB_TOKEN) with actions: write and checks: read, and
// GITHUB_REPOSITORY (owner/name). --attempt is the attempt the caller saw
// finish; the run is left alone if it has moved on since. --dry-run prints
// the decision without re-running anything.

// Automatic re-runs per CI run: attempts 1 to MAX_RETRIES may be re-run, so
// attempt MAX_RETRIES + 1 is the last. Manual re-runs count too.
const MAX_RETRIES = 3;

// The aggregator fails whenever a job it needs did not pass, so its failure
// says nothing on its own.
const AGGREGATOR = "Check";

// GitHub's annotation on a job it cancelled because no hosted runner picked
// it up (seen on runs 44135265518 and 44170120000).
const NO_RUNNER = /was not acquired by Runner of type hosted/i;

// GitHub's annotation on a job cancelled by `concurrency: cancel-in-progress`
// (a newer push to the same PR).
const CONCURRENCY = /Canceling since a higher priority waiting request/i;

function hadRunner(job) {
	return Boolean(job.runner_id) || Boolean(job.runner_name) || (job.steps?.length ?? 0) > 0;
}

// run: the workflow run (id, event, conclusion, run_attempt, status).
// jobs: that attempt's jobs. annotations: { [job id]: [annotation message] }
// for every cancelled job. newestRunId: the newest CI run for the same branch
// and event, or null when unknown. seenAttempt: the attempt the caller saw
// finish, or null.
// Returns { retry: boolean, reason: string, jobs: [names of no-runner jobs] }.
function classify({ run, jobs, annotations, newestRunId = null, seenAttempt = null, maxRetries = MAX_RETRIES }) {
	const no = (reason, names = []) => ({ retry: false, reason, jobs: names });
	if (run.status !== "completed") return no(`run is ${run.status}, not completed`);
	if (run.conclusion === "success") return no("run succeeded");

	const messages = (job) => annotations[job.id] ?? [];
	const noRunner = [];
	for (const job of jobs) {
		if (job.name === AGGREGATOR) continue;
		if (job.conclusion === "success" || job.conclusion === "skipped" || job.conclusion === "neutral") continue;
		if (job.conclusion !== "cancelled") {
			return no(`${job.name} concluded ${job.conclusion ?? job.status}, a real failure`);
		}
		if (messages(job).some((m) => CONCURRENCY.test(m))) {
			return no(`${job.name} was cancelled by a newer run (concurrency)`);
		}
		if (hadRunner(job) || !messages(job).some((m) => NO_RUNNER.test(m))) {
			return no(`${job.name} was cancelled, not for lack of a runner`);
		}
		noRunner.push(job.name);
	}
	if (noRunner.length === 0) return no("no job was cancelled for lack of a runner");
	if (run.run_attempt > maxRetries) {
		return no(`attempt ${run.run_attempt} is past the cap of ${maxRetries} automatic re-runs`, noRunner);
	}
	if (seenAttempt != null && run.run_attempt !== seenAttempt) {
		return no(`run moved on to attempt ${run.run_attempt} (saw ${seenAttempt})`, noRunner);
	}
	if (run.event === "pull_request" && newestRunId != null && newestRunId !== run.id) {
		return no(`a newer CI run (${newestRunId}) exists for this pull request branch`, noRunner);
	}
	return { retry: true, reason: `no hosted runner for ${noRunner.join(", ")}`, jobs: noRunner };
}

async function api(path, { method = "GET", token } = {}) {
	const response = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"x-github-api-version": "2022-11-28",
			"user-agent": "ci-runner-retry",
		},
	});
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
	return response.status === 204 || response.status === 201 ? null : response.json();
}

async function allJobs(repo, run, token) {
	const jobs = [];
	for (let page = 1; ; page++) {
		const body = await api(`/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`, { token });
		jobs.push(...body.jobs);
		if (jobs.length >= body.total_count || body.jobs.length === 0) return jobs;
	}
}

async function main(argv) {
	const arg = (name) => {
		const i = argv.indexOf(name);
		return i === -1 ? null : argv[i + 1];
	};
	const runId = Number(arg("--run"));
	const seenAttempt = arg("--attempt") == null ? null : Number(arg("--attempt"));
	const dryRun = argv.includes("--dry-run");
	const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	const repo = process.env.GITHUB_REPOSITORY;
	if (!runId || !token || !repo) throw new Error("Usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/name ci-runner-retry.cjs --run <id> [--attempt <n>] [--dry-run]");

	let decision = await decide(repo, runId, seenAttempt, token);
	console.log(decision.summary);
	if (!decision.retry) return decision;
	if (dryRun) {
		console.log("Dry run: not re-running.");
		return decision;
	}
	// Read everything again right before re-running, so a push or a manual
	// re-run that landed while we looked is not cancelled or raced.
	decision = await decide(repo, runId, seenAttempt, token);
	if (!decision.retry) {
		console.log(`Changed while deciding: ${decision.summary}`);
		return decision;
	}
	await api(`/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: "POST", token });
	console.log(`Re-ran the failed jobs of run ${runId} (now attempt ${decision.attempt + 1}).`);
	return decision;
}

async function decide(repo, runId, seenAttempt, token) {
	const run = await api(`/repos/${repo}/actions/runs/${runId}`, { token });
	const jobs = await allJobs(repo, run, token);
	const annotations = {};
	for (const job of jobs) {
		if (job.conclusion !== "cancelled") continue;
		const list = await api(`/repos/${repo}/check-runs/${job.id}/annotations?per_page=100`, { token });
		annotations[job.id] = list.map((a) => a.message);
	}
	let newestRunId = null;
	if (run.event === "pull_request") {
		// Same branch name from the same repository: two forks' PRs can share a
		// branch name such as patch-1.
		const query = new URLSearchParams({ branch: run.head_branch, event: run.event, per_page: "30" });
		const { workflow_runs: runs } = await api(`/repos/${repo}/actions/workflows/${run.workflow_id}/runs?${query}`, { token });
		const sameHead = runs.filter((r) => r.head_repository?.full_name === run.head_repository?.full_name);
		newestRunId = sameHead[0]?.id ?? null;
	}
	const decision = classify({ run, jobs, annotations, newestRunId, seenAttempt });
	const summary = `Run ${run.id} attempt ${run.run_attempt} (${run.event}, ${run.conclusion}): ${decision.retry ? "re-run" : "leave"}, ${decision.reason}.`;
	return { ...decision, summary, attempt: run.run_attempt };
}

module.exports = { classify, MAX_RETRIES };

if (require.main === module) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
