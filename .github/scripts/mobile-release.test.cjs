const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { attempt, buildMessage, checkConfig, countExpoModules, decide, isOlderThan } = require("./mobile-release.cjs");

const F = "a".repeat(40);
const G = "b".repeat(40);
const X = "c".repeat(40);
const NOW = Date.parse("2026-11-19T12:00:00Z");
const daysAgo = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

/** A beta build as fetchState returns it. Finished builds default to a finished TestFlight upload. */
function build(id, status, runtime, { submission = status === "FINISHED" ? "FINISHED" : undefined, requested, days = 1 } = {}) {
	return {
		id,
		status,
		message: requested ? buildMessage("123456789abc", requested) : null,
		createdAt: daysAgo(days),
		completedAt: daysAgo(days),
		runtime: runtime ? { version: runtime } : null,
		submissions: submission ? [{ platform: "IOS", status: submission, completedAt: daysAgo(days) }] : [],
	};
}
const run = (overrides) => decide({ event: "push", ref: "refs/heads/main", tokenPresent: true, runtime: G, expoModules: 24, builds: [build("old", "FINISHED", F)], now: NOW, ...overrides });

test("a JS-only merge publishes an OTA when the newest TestFlight build has the runtime", () => {
	assert.equal(run({ runtime: F }).action, "update");
});

test("a new runtime with no build starts exactly one build", () => {
	assert.equal(run({}).action, "build");
});

test("a build in progress for the runtime publishes and builds nothing", () => {
	for (const status of ["NEW", "IN_QUEUE", "IN_PROGRESS"]) {
		assert.equal(run({ builds: [build("new", status, G), build("old", "FINISHED", F)] }).action, "none", status);
	}
});

test("an errored or canceled build for the runtime fails the run without a build", () => {
	for (const status of ["ERRORED", "CANCELED"]) {
		const decision = run({ builds: [build("new", status, G), build("old", "FINISHED", F)] });
		assert.equal(decision.action, "fail", status);
		assert.match(decision.reason, /mode build/);
	}
});

test("a finished build counts only once its TestFlight upload finished", () => {
	assert.equal(attempt(build("x", "FINISHED", F)).state, "shipped");
	for (const submission of ["AWAITING_BUILD", "IN_QUEUE", "IN_PROGRESS"]) {
		assert.equal(attempt(build("x", "FINISHED", F, { submission })).state, "active", submission);
		// An upload still running is not on TestFlight: nothing to publish yet, and no second build.
		assert.equal(run({ runtime: F, builds: [build("x", "FINISHED", F, { submission })] }).action, "none", submission);
	}
	for (const submission of ["ERRORED", "CANCELED", null]) {
		const builds = [build("x", "FINISHED", G, { submission }), build("old", "FINISHED", F)];
		assert.equal(attempt(builds[0]).state, "failed", String(submission));
		assert.equal(run({ builds }).action, "fail", String(submission));
		assert.equal(run({ runtime: G, builds }).action, "fail", String(submission));
	}
	// A build whose upload failed never counts as the newest TestFlight build.
	assert.equal(run({ runtime: G, builds: [build("x", "FINISHED", G, { submission: "ERRORED" }), build("old", "FINISHED", F)] }).action, "fail");
});

test("attempts match on the requested runtime even when Expo recorded another", () => {
	for (const status of ["IN_PROGRESS", "ERRORED", "CANCELED"]) {
		const decision = run({ builds: [build("new", status, null, { requested: G }), build("old", "FINISHED", F)] });
		assert.notEqual(decision.action, "build", status);
	}
});

test("any active beta build blocks an automatic build", () => {
	assert.equal(run({ builds: [build("other", "IN_PROGRESS", X), build("old", "FINISHED", F)] }).action, "none");
	assert.equal(run({ event: "schedule", builds: [build("other", "IN_QUEUE", X), build("old", "FINISHED", F, { days: 80 })] }).action, "none");
});

test("a finished build whose recorded runtime differs from the requested one fails without a build", () => {
	const mismatched = build("new", "FINISHED", X, { requested: G });
	for (const event of ["push", "schedule"]) {
		const decision = run({ event, builds: [mismatched, build("old", "FINISHED", F)] });
		assert.equal(decision.action, "fail", event);
		assert.match(decision.reason, /recorded runtime/);
	}
	// It is found behind a newer finished build whose upload failed, and when its own upload failed.
	assert.equal(run({ builds: [build("newer", "FINISHED", X, { submission: "ERRORED" }), mismatched] }).action, "fail");
	assert.match(run({ builds: [build("new", "FINISHED", X, { requested: G, submission: "ERRORED" }), build("old", "FINISHED", F)] }).reason, /recorded runtime/);
	// A later consistent TestFlight build supersedes it.
	assert.equal(run({ runtime: F, builds: [build("fixed", "FINISHED", F, { requested: F }), mismatched] }).action, "update");
});

test("an OTA goes only to the newest TestFlight build, and only before it expires", () => {
	// After a native change G and a revert back to F, phones run G: F needs a new build.
	assert.equal(run({ runtime: F, builds: [build("g", "FINISHED", G), build("f", "FINISHED", F, { days: 10 })] }).action, "build");
	assert.equal(run({ runtime: F, builds: [build("f", "FINISHED", F, { days: 89 })] }).action, "update");
	assert.equal(run({ runtime: F, builds: [build("f", "FINISHED", F, { days: 90 })] }).action, "build");
});

test("an older commit never publishes after a newer OTA for the same runtime", () => {
	assert.equal(run({ runtime: F, stale: true }).action, "none");
	assert.equal(run({ event: "workflow_dispatch", mode: "update", runtime: F, stale: true }).action, "fail");
});

test("a runtime that hashes no Expo native modules publishes nothing", () => {
	assert.equal(run({ runtime: F, expoModules: 0 }).action, "fail");
	assert.equal(run({ event: "workflow_dispatch", mode: "update", runtime: F, expoModules: 0 }).action, "fail");
});

test("Monday refreshes a build 76 or more days old and leaves 75 days alone", () => {
	const at = (days) => run({ event: "schedule", builds: [build("old", "FINISHED", F, { days })] });
	assert.equal(at(75).action, "none");
	assert.equal(at(75.9).action, "none");
	assert.equal(at(76).action, "build");
	assert.equal(at(82).action, "build");
});

test("Monday ages the newest build on TestFlight, not the newest finished one", () => {
	const old = build("old", "FINISHED", F, { days: 80 });
	assert.equal(run({ event: "schedule", builds: [build("new", "FINISHED", F, { submission: "ERRORED", days: 2 }), old] }).action, "fail");
	assert.equal(run({ event: "schedule", builds: [build("new", "FINISHED", F, { submission: "CANCELED", days: 2 }), old] }).action, "fail");
	assert.equal(run({ event: "schedule", builds: [build("new", "FINISHED", F, { submission: "IN_PROGRESS", days: 0 }), old] }).action, "none");
});

test("Monday does nothing while a build runs and fails after an errored build", () => {
	const finished = build("old", "FINISHED", F, { days: 80 });
	assert.equal(run({ event: "schedule", builds: [build("new", "IN_PROGRESS", F), finished] }).action, "none");
	assert.equal(run({ event: "schedule", builds: [build("new", "ERRORED", F), finished] }).action, "fail");
	assert.equal(run({ event: "schedule", builds: [] }).action, "build");
});

test("the build button always builds, even with a finished, errored or mismatched build", () => {
	for (const builds of [[build("x", "FINISHED", G)], [build("x", "ERRORED", G)], [build("x", "FINISHED", X, { requested: G })]]) {
		assert.equal(run({ event: "workflow_dispatch", mode: "build", builds }).action, "build");
	}
});

test("the update button publishes only for the newest TestFlight build's runtime", () => {
	assert.equal(run({ event: "workflow_dispatch", mode: "update", runtime: F }).action, "update");
	assert.equal(run({ event: "workflow_dispatch", mode: "update" }).action, "fail");
	assert.equal(run({ event: "workflow_dispatch", mode: "update", builds: [build("new", "IN_PROGRESS", G)] }).action, "fail");
});

test("the check button only reads, and flags a newest build that failed or was cancelled", () => {
	const check = (builds) => run({ event: "workflow_dispatch", mode: "check", builds });
	assert.equal(check([build("old", "FINISHED", F)]).action, "check");
	assert.equal(check([build("old", "FINISHED", F)]).problem, undefined);
	for (const newest of [build("new", "CANCELED", G), build("new", "FINISHED", G, { submission: "CANCELED" })]) {
		const decision = check([newest, build("old", "FINISHED", F)]);
		assert.equal(decision.action, "check");
		assert.match(decision.problem, /failed/);
	}
});

test("refs other than main and a missing token fail before anything else", () => {
	for (const mode of ["build", "update", "check"]) {
		assert.equal(run({ event: "workflow_dispatch", mode, ref: "refs/heads/feature" }).action, "fail", mode);
		assert.equal(run({ event: "workflow_dispatch", mode, tokenPresent: false }).action, "fail", mode);
	}
	assert.match(run({ ref: "refs/tags/v1" }).reason, /only on main/);
	assert.match(run({ tokenPresent: false }).reason, /EXPO_TOKEN/);
});

test("countExpoModules counts only Expo autolinking sources for the platform", () => {
	const sources = [{ reasons: ["expoAutolinkingIos"] }, { reasons: ["expoAutolinkingAndroid"] }, { reasons: ["bareGitIgnore"] }, {}];
	assert.equal(countExpoModules(sources), 1);
	assert.equal(countExpoModules([]), 0);
});

test("checkConfig accepts the committed config and names each missing field", () => {
	const mobile = path.join(__dirname, "..", "..", "apps", "mobile");
	const appJson = JSON.parse(fs.readFileSync(path.join(mobile, "app.json"), "utf8")).expo;
	const easJson = JSON.parse(fs.readFileSync(path.join(mobile, "eas.json"), "utf8"));
	assert.deepEqual(checkConfig(appJson, easJson), []);
	assert.deepEqual(checkConfig({ extra: { eas: { projectId: "p" } }, ios: { runtimeVersion: "1" }, android: { runtimeVersion: { policy: "appVersion" } } }, {}), [
		"updates.enabled must be true",
		"updates.url must be https://u.expo.dev/<projectId>",
		"runtimeVersion.policy must be fingerprint",
		"ios.runtimeVersion must not override the fingerprint policy",
		"android.runtimeVersion must not override the fingerprint policy",
		"eas.json build.beta.channel must be production",
		"eas.json submit.beta.ios.ascAppId is missing",
		"eas.json submit.beta.ios.ascApiKeyPath is missing",
		"eas.json submit.beta.ios.ascApiKeyIssuerId is missing",
		"eas.json submit.beta.ios.ascApiKeyId is missing",
	]);
});

test("isOlderThan is true only for a strict ancestor", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-release-git-"));
	const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
	git("init", "-q");
	git("commit", "-q", "--allow-empty", "-m", "a");
	const a = git("rev-parse", "HEAD");
	git("commit", "-q", "--allow-empty", "-m", "b");
	const b = git("rev-parse", "HEAD");
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		assert.equal(isOlderThan(a, b), true);
		assert.equal(isOlderThan(b, a), false);
		assert.equal(isOlderThan(b, b), false);
		assert.equal(isOlderThan(b, undefined), false);
		assert.throws(() => isOlderThan(b, X), /Could not compare/);
	} finally {
		process.chdir(cwd);
		fs.rmSync(dir, { recursive: true });
	}
});

test("the decide command reads CLI output with leading notices and prints step outputs", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-release-"));
	const runtimeFile = path.join(dir, "runtime.json");
	const stateFile = path.join(dir, "state.json");
	fs.writeFileSync(runtimeFile, `A notice\n${JSON.stringify({ runtimeVersion: F, fingerprintSources: [{ reasons: ["expoAutolinkingIos"] }] })}`);
	fs.writeFileSync(stateFile, JSON.stringify({ builds: [build("old", "FINISHED", F)], latestUpdate: null, latestUpdateForRuntime: null }));
	const env = { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "0123456789abcdef", EXPO_TOKEN: "x" };
	const script = path.join(__dirname, "mobile-release.cjs");
	const output = execFileSync(process.execPath, [script, "decide", runtimeFile, stateFile], { env, encoding: "utf8" });
	assert.match(output, /^action=update$/m);
	assert.match(output, new RegExp(`^runtime=${F}$`, "m"));
	assert.match(output, new RegExp(`^message=Mobile release 012345678, fingerprint ${F}$`, "m"));
	assert.match(output, /^problem=$/m);
	fs.rmSync(dir, { recursive: true });
	assert.throws(() => execFileSync(process.execPath, [script, "preflight"], { env: { ...env, GITHUB_REF: "refs/heads/x" }, stdio: "pipe" }));
});
